// core/errors.js — 领域错误工厂（唯一权威，从 api/service.js 上移至此）。
// 目的：切断 api/lifecycle、write-path、search-path、maintenance 等承接模块
// 反向 import api/service.js 形成的循环依赖——它们只取错误工厂，改从本模块拿。
// 错误形状与文本逐字保留（测试逐字断言 message，测试断言 err.code）。

/** 记录级校验失败（err.code='E_INVALID_RECORD'）。 */
export function invalid(msg) {
  const err = new Error(msg);
  err.code = 'E_INVALID_RECORD';
  return err;
}

/** 目标不存在（err.code='E_NOT_FOUND'）。 */
export function notFound(msg) {
  const err = new Error(msg);
  err.code = 'E_NOT_FOUND';
  return err;
}

/** 参数级校验失败（err.code='E_INVALID_ARG'）。 */
export function invalidArg(msg) {
  const err = new Error(msg);
  err.code = 'E_INVALID_ARG';
  return err;
}
