/**
 * m6-108：按顺序保存仍然脏的文件，返回保存之后仍然脏的文件 id。
 *
 * - `isDirty` 必须读取宿主的最新状态（每次调用时求值），不能依赖渲染后的快照。
 * - 单个文件保存失败不会中止其余文件的保存；失败原因由 `save` 自己呈现，文件保持脏状态。
 * - 调用方据返回值决定是否继续原动作（退出或关闭）：返回空数组才可以继续。
 */
export async function saveAllDirtyFiles(
  documentIds: readonly string[],
  save: (documentId: string) => Promise<void>,
  isDirty: (documentId: string) => boolean,
): Promise<string[]> {
  for (const documentId of documentIds) {
    if (!isDirty(documentId)) continue;
    try {
      await save(documentId);
    } catch {
      // The save already reported the failure; the document is still dirty and is returned below.
    }
  }
  return documentIds.filter((documentId) => isDirty(documentId));
}
