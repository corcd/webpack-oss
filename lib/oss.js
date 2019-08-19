const fs = require("fs");
const path = require("path");
const OSS = require("ali-oss");
const colors = require("ansi-colors");
const log = require("fancy-log");
const utils = require('./utils');
const regexp = utils.regexp;

class AliOSS {
  constructor(options) {
    if (Object.prototype.toString.call(options) !== '[object Object]') {
      throw new Error(`配置信息应该是Object`)
    }

    this.config = Object.assign({
      prefix: '',
      exclude: null,
      format: null,
      deleteAll: false,
      output: './dist',
      local: false,
      limit: 5
    }, options)

    if (['accessKeyId', 'accessKeySecret', 'bucket', 'region'].some(key => !options[key])
    ) {
      throw new Error(`请填写正确的accessKeyId、accessKeySecret和bucket`)
    }

    if (this.config.format) {
      const format = this.config.format;
      if (!regexp.test(format) && !/[0-9]+/.test(format)) {
        throw new Error(`format格式由纯数字或YYYY、YY、MM、DD、HH、hh、mm、SS、ss组成`)
      } else if (regexp.test(format)) {
        this.config.format = utils.formatDate(new Date(), format)
      }
    }

    this.client = new OSS(this.config)
  }

  upload() {
    if (this.config.format) {
      this.delCacheAssets()
    } else if (this.config.deleteAll) {
      this.delAllAssets()
    } else {
      this.uploadAssets()
    }
  }

  apply(compiler) {
    if (this.config.accessKeyId && this.config.accessKeySecret) {
      if (this.config.output) {
        this.output = this.config.output
      } else {
        this.output = compiler.outputPath || compiler.options.output.path;
      }
      if (compiler.hooks) {
        compiler.hooks.done.tapAsync("WebpackAliOSSPlugin", this.init.bind(this));
      } else {
        compiler.plugin("done", this.init.bind(this));
      }
    } else {
      log(colors.red(`请填写正确的accessKeyId、accessKeySecret和bucket`));
    }
  }


  async delFilterAssets(prefix) {
    try {
      const list = [];
      list.push(prefix);
      let result = await this.client.list({
        prefix,
        "max-keys": 1000
      });
      if (result.objects) {
        result.objects.forEach(file => {
          list.push(file.name);
        });
      }
      if (Array.isArray(list)) {
        result = await this.client.deleteMulti(list, {
          quiet: true
        });
      }
    } catch (error) {
      log(colors.red(`删除缓存文件失败!`));
    }
  }

  async delCacheAssets() {
    const prefix = this.config.prefix;
    const list = [];
    try {
      const dirList = await this.client.list({
        prefix: `${prefix}/`,
        delimiter: "/"
      });

      if (dirList.prefixes) {
        dirList.prefixes.forEach(subDir => {
          list.push(+subDir.slice(prefix.length + 1, -1));
        });
      }

      if (list.length > 1) {
        const limit = this.config.limit > 3 ? this.config.limit - 1 : 2;
        const array = list.slice().sort((a, b) => a - b).splice(limit)
        await this.asyncForEach(array, async (item, index) => {
          await this.delFilterAssets(
            `${prefix}/${item}`
          );
        })
      }

      this.uploadAssets();
    } catch (error) {
      this.uploadAssets();
    }
  }

  async asyncForEach(arr, cb) {
    for (let i = 0; i < arr.length; i++) {
      await cb(arr[i], i)
    }
  }


  async delAllAssets() {
    try {
      const { prefix } = this.config;
      let result = await this.client.list({
        prefix,
        "max-keys": 1000
      });
      if (result.objects) {
        result = result.objects.map(file => file.name);
      }
      if (Array.isArray(result)) {
        result = await this.client.deleteMulti(result, { quiet: true });
      }
      this.uploadAssets();
    } catch (error) {
      this.uploadAssets();
    }
  }


  async uploadAssets() {
    if (this.config.local) {
      await this.uploadLocale(this.config.output);
    } else {
      await this.asyncForEach(Object.keys(this.assets), async (name, index) => {
        if (this.filterFile(name)) {
          await this.update(name, Buffer.from(this.assets[name].source(), "utf8"));
        }
      })
    }
  }

  filterFile(name) {
    const { exclude } = this.config;
    return (
      !exclude ||
      ((Array.isArray(exclude) && !exclude.some(item => item.test(name))) ||
        (!Array.isArray(exclude) && !exclude.test(name)))
    );
  }

  getFileName(name) {
    const { config } = this;
    const prefix = config.format
      ? path.join(config.prefix, config.format.toString())
      : config.prefix;
    return path.join(prefix, name).replace(/\\/g, "/");
  }

  async update(name, content) {
    const fileName = this.getFileName(name);
    try {
      const result = await this.client.put(fileName, content);
      if (+result.res.statusCode === 200) {
        log(colors.green(`${fileName}上传成功!`));
      } else {
        log(colors.red(`${fileName}上传失败!`));
      }
    } catch (error) {
      log(colors.red(`${fileName}上传失败!`));
    }
  }

  async uploadLocale(dir) {
    const result = fs.readdirSync(dir);
    await this.asyncForEach(result, async file => {
      const filePath = path.join(dir, file);
      if (this.filterFile(filePath)) {
        if (fs.lstatSync(filePath).isDirectory()) {
          await this.uploadLocale(filePath);
        } else {
          const fileName = filePath.slice(this.config.output.length);
          await this.update(fileName, filePath);
        }
      }
    })
  }
}
module.exports = AliOSS;