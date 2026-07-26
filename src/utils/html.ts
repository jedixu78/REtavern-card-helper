/**
 * HTML 转义工具（应用内单一来源）。
 *
 * 默认转义 `&`、`<`、`>`——足以保证纯文本内容嵌入 HTML 时不会被解析成标签，
 * 适用于放在标签之间的文本内容（如 dangerouslySetInnerHTML 的 <pre> 内容）。
 *
 * 当值要放进 HTML 属性值（单/双引号内）时，传 `{ quotes: true }` 额外转义
 * `"` → `&quot;`、`'` → `&#39;`，防止提前闭合属性。
 *
 * 注意：这是「应用自身渲染」用的转义。导出到角色卡内、随卡片在 SillyTavern
 * 运行时执行的内联转义函数（如 live-chat-templates 中的 lcEsc）不在此列。
 */
export function escapeHtml(str: unknown, options?: { quotes?: boolean }): string {
  let out = String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  if (options?.quotes) {
    out = out.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  return out;
}
