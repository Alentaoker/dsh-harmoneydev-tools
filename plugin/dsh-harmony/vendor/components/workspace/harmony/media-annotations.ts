export type AnnotationTool = 'move' | 'rect' | 'arrow' | 'text' | 'redact';
export type AnnotationMark = { tool: AnnotationTool; x: number; y: number; endX: number; endY: number; text: string; color: string };
export const textFontSize = (width: number) => Math.max(24, width / 30);

export function textMarkAt(marks: AnnotationMark[], x: number, y: number, width: number, measure: (text: string) => number) {
  const height = textFontSize(width) * 1.25;
  for (let index = marks.length - 1; index >= 0; index--) {
    const mark = marks[index];
    if (mark.tool === 'text' && x >= mark.x - 4 && y >= mark.y - 4 && x <= mark.x + Math.max(16, measure(mark.text)) + 4 && y <= mark.y + height) return index;
  }
  return -1;
}

export function editTextMark(marks: AnnotationMark[], index: number | null, mark: AnnotationMark) {
  if (index !== null && (!Number.isInteger(index) || index < 0 || marks[index]?.tool !== 'text')) throw Error('文字批注已失效，请重新选择');
  const text = mark.text.slice(0, 200);
  if (!text.trim()) return index === null ? marks : marks.filter((_, i) => i !== index);
  if (index === null) { if (marks.length >= 200) throw Error('单张图片最多 200 个批注'); return [...marks, { ...mark, text }]; }
  return marks.map((value, i) => i === index ? { ...mark, text } : value);
}
