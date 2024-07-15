import localforage from "localforage";
import md5 from "md5"

export default class RpcCache {
  defaultExpires: number;
  lc: any;
  tasks: any;
  waitTask: any;
  stateKey: string;
  broadcast: any;

  constructor ({ expires }: any = {}) {
    this.defaultExpires = expires || 1000 * 60 * 60 * 24; // 一天
    this.lc = localforage.createInstance({
      name: "RpcCache"
    })
    this.stateKey = "RpcCache-state";
    this.tasks = {};
    this.waitTask = this.getState();
    this.broadcast = new BroadcastChannel('RpcCache-message');
    this.loadFetch();
  }

  // 加载缓存中等待请求
  loadFetch () {
    const keys = Object.keys(this.waitTask);
    if (keys.length) {
      // 等待中的接口一直未响应
      let timer: any = setTimeout(() => {
        const callbacks = Object.values(this.waitTask);
        if (callbacks.length) {
          callbacks.forEach((items: any) => {
            items.forEach((item: any) => {
              if (item.reject) {
                item.reject("接口超时");
              }
            })
          })
          this.waitTask = {};
          this.saveState({});
          this.broadcast.close();
        }
      }, 30000);
      this.broadcast.onmessage = (e: any) => {
        window.clearTimeout(timer);
        timer = null;
        const { code, key, res } = e.data;
        const action = code === 1 ? "resolve" : "reject";
        if (Reflect.has(this.waitTask, key)) {
          this.waitTask[key].forEach((item: any) => {
            item[action](JSON.parse(res));
          })
        };
        this.lc.setItem(key, {
          res: JSON.parse(res),
          exp: Date.now() + this.defaultExpires
        });
        delete this.waitTask[key];
        this.saveState(this.waitTask);
        if (Object.keys(this.waitTask).length === 0) {
          this.broadcast.close();
        }
      }
    }
  }

  async fetchUrl (fn: any, { url, expires, data, inKey = {}, cache = true }: any) {
    if (!fn || typeof fn !== "function") {
      return "请传入函数";
    }
    const now = Date.now();
    const key = md5(`${url}-${JSON.stringify(data)}-${inKey}`);
    if (cache) {
      // 等待队列有请求
      if (Reflect.has(this.waitTask, key)) {
        return new Promise((resolve, reject) => {
          this.waitTask[key].push({ resolve, reject });
        })
      }
      const { res, exp }: any = await this.lc.getItem(key) || {};
      // indexdb有缓存未过期
      if (exp && exp > now && res) {
        return res
      }
      // 有相同的请求在等待
      if (Reflect.has(this.tasks, key)) {
        return new Promise((resolve, reject) => {
          this.tasks[key].push({ resolve, reject });
        })
      }
    }
    this.tasks[key] = [];
    this.saveState(this.tasks);
    try {
      const response = await fn(url, data);
      this.tasks[key].forEach((item: any) => {
        item.resolve(response);
      })
      this.lc.setItem(key, {
        res: response,
        exp: now + (expires ?? this.defaultExpires)
      });
      this.broadcast.postMessage({
        code: 1,
        key,
        res: JSON.stringify(response)
      });
      return response
    } catch (err) {
      this.tasks[key].forEach((item: any) => {
        item.reject(err);
      })
      this.broadcast.postMessage({
        code: 2,
        key,
        res: JSON.stringify(err)
      });
      return Promise.reject(err);
    } finally {
      delete this.tasks[key];
      this.saveState(this.tasks);
    }
  }

  // 清除过期缓存
  clearExpires () {
    const now = Date.now();
    this.lc.iterate((value: any, key: string) => {
      if (now > value.exp) {
        this.lc.removeItem(key);
      }
    })
  }

  // 清除所有缓存
  clearCache () {
    this.lc.clear();
  }

  // 获取等待中的请求
  getState () {
    const str = localStorage.getItem(this.stateKey);
    if (str) {
      return JSON.parse(str);
    }
    return {}
  }

  // 保存等待中的请求
  saveState (tasks: any) {
    localStorage.setItem(this.stateKey, JSON.stringify(tasks));
  }

  // 销毁
  destroy () {
    this.clearExpires();
    this.saveState({})
  }
}
