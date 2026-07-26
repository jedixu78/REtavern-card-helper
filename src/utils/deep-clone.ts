/**
 * 深拷贝工具：优先使用 structuredClone，降级到 JSON.parse(JSON.stringify(...))。
 * 用于在修改前复制对象，避免变更影响原始引用。
 *
 * 注意：JSON 降级路径会丢弃函数、undefined、Symbol、循环引用等，但本项目
 * 拷贝的都是可序列化的纯数据结构（卡片 JSON、MVU 配置等），符合预期。
 */
export function deepClone<T>(obj: T): T {
  if (obj === undefined || obj === null) return obj;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(obj);
    } catch {
      // 含函数/循环引用等无法被 structuredClone 的对象降级到 JSON 方案
    }
  }
  return JSON.parse(JSON.stringify(obj)) as T;
}
