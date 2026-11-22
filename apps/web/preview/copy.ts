export const zh = {
  steps: [
    { title: '准备', body: '把常用工具放在触手可及的位置。先确认肤感和需要避开的部位。' },
    { title: '薄涂底妆', body: '从少量开始，轻按并沿脸部向外推开。鼻翼和下颌用指腹感受边界，按需补匀。' },
    { title: '调整唇部', body: '沿唇线少量涂抹，抿唇后停下来检查是否舒适。准备完成后，可以回顾本次练习。' },
  ],
  mediaError: '无法开启摄像头。你可以继续文字练习。',
  sample: '演练反馈：信息不足，无法判断。本次没有分析照片，也没有妆效预测。',
  speechUnavailable: '没有找到本机中文朗读音色。请通过屏幕阅读器或直接阅读文字。',
  callFailed: '没有收到本机模拟服务的结果，可以重试。',
  memoryError: '当前操作没有完成。请重新读取记录后重试。',
};

export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing preview element ${id}`);
  return node as T;
}
