// mcp/scope-state.js —— 薄 re-export：实现已迁到 core/scope-state.js。
// 保留本路径只为兼容旧 import（tests / 外部引用），web 侧请直接 import core。
export {
  SCOPE_PATTERN,
  clientKey,
  scopeFilePath,
  readScopeOverride,
  writeScopeOverride,
  initScopeState,
  resolveUseTarget,
} from '../core/scope-state.js';
