/** 前后端共用的导出范围规则。服务端始终用自己的资产与标记重新计算。 */
export function resolveExportScope(assets, data, scope = { kind: 'all' }) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) fail('请选择有效的导出范围');
  if (!['all', 'client', 'filtered', 'selection'].includes(scope.kind)) fail('不支持这个导出范围');

  let marks = { ...data.marks };
  let scoped = assets;
  if (scope.kind === 'selection') {
    if (!Array.isArray(scope.assetIds) || scope.assetIds.length === 0
      || scope.assetIds.some((id) => typeof id !== 'string' || id === '')) {
      fail('请先选择要导出的照片');
    }
    const ids = new Set(scope.assetIds);
    const known = new Set(assets.map((asset) => asset.id));
    if ([...ids].some((id) => !known.has(id))) fail('选中的照片已不在当前文件夹，请刷新后重新选择');
    scoped = assets.filter((asset) => ids.has(asset.id));
    marks = Object.fromEntries(scoped.map((asset) => [asset.id, 'pick']));
  } else {
    const clientId = scope.kind === 'client' || scope.kind === 'filtered' ? scope.clientId : null;
    if (scope.kind === 'client' && (typeof clientId !== 'string' || clientId === '')) {
      fail('请选择要导出的客户');
    }
    if (clientId !== undefined && clientId !== null) {
      if (typeof clientId !== 'string' || clientId === '') fail('客户信息无效，请重新选择');
      marks = {};
      for (const asset of assets) {
        const mark = data.contrib?.[asset.id]?.[clientId]?.mark;
        if (mark === 'pick' || mark === 'reject') marks[asset.id] = mark;
      }
    }
    if (scope.kind === 'filtered') {
      const { dir = null, tab = 'all' } = scope;
      if (dir !== null && typeof dir !== 'string') fail('文件夹筛选无效，请重新选择');
      if (!['all', 'pick', 'reject', 'none', 'hidden'].includes(tab)) fail('照片筛选无效，请重新选择');
      const hidden = new Set(data.hidden ?? []);
      scoped = assets.filter((asset) => {
        if (dir !== null && asset.dir !== dir) return false;
        if (tab === 'hidden') return hidden.has(asset.id);
        if (hidden.has(asset.id)) return false;
        const mark = marks[asset.id];
        if (tab === 'all') return !clientId || mark !== undefined;
        return tab === 'none' ? mark === undefined : mark === tab;
      });
    }
  }
  return { assets: scoped, marks };
}
