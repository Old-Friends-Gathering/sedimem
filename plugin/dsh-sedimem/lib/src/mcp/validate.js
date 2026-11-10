/**
 * 极简 JSON Schema 子集校验器（fail-loud）。
 * 覆盖 memo inputSchema 实际用到的关键字：
 *   type / properties / required / additionalProperties:false /
 *   enum / minimum / maximum / items / pattern
 * 校验失败返回 { ok:false, errors: string[] }，由调用方转为 isError:true。
 */

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function validateValue(path, schema, value, errors) {
  if (value === undefined) return; // required 由父级检查

  if (schema.type) {
    const actual = typeOf(value);
    if (actual !== schema.type) {
      errors.push(`参数 ${path} 类型不符: 期望 ${schema.type}，实际 ${actual}`);
      return; // 类型不对后续检查无意义
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`参数 ${path} 取值越界: ${JSON.stringify(value)}，允许值 [${schema.enum.join(', ')}]`);
  }
  if (schema.type === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`参数 ${path} 越界: ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`参数 ${path} 越界: ${value} > maximum ${schema.maximum}`);
    }
  }
  if (schema.type === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(`参数 ${path} 不匹配 pattern ${schema.pattern}`);
  }
  if (schema.type === 'array' && schema.items) {
    value.forEach((item, i) => validateValue(`${path}[${i}]`, schema.items, item, errors));
  }
  if (schema.type === 'object') {
    validateObject(path, schema, value, errors);
  }
}

function validateObject(path, schema, obj, errors) {
  const props = schema.properties || {};
  for (const key of Object.keys(obj)) {
    if (!(key in props)) {
      errors.push(`未知参数: ${key}` + (path ? ` (在 ${path} 内)` : ''));
      continue;
    }
    validateValue(path ? `${path}.${key}` : key, props[key], obj[key], errors);
  }
  for (const req of schema.required || []) {
    if (!(req in obj)) {
      errors.push(`缺少必填参数: ${req}` + (path ? ` (在 ${path} 内)` : ''));
    }
  }
}

/**
 * @returns {{ok: true} | {ok: false, errors: string[]}}
 */
export function validateArgs(schema, args) {
  if (typeOf(args) !== 'object') {
    return { ok: false, errors: [`参数 arguments 类型不符: 期望 object，实际 ${typeOf(args)}`] };
  }
  const errors = [];
  validateObject('', schema, args, errors);
  return errors.length ? { ok: false, errors } : { ok: true };
}
