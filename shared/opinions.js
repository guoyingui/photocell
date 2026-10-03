/** 客户意见只统计客户自己的票；摄影师的决定单独显示。 */
export function summarizeOpinions(votes = {}) {
  let picks = 0, rejects = 0;
  for (const [userId, vote] of Object.entries(votes)) {
    if (userId === 'admin') continue;
    if (vote?.mark === 'pick') picks++;
    else if (vote?.mark === 'reject') rejects++;
  }
  return { picks, rejects, common: picks >= 2 && rejects === 0,
    conflict: picks > 0 && rejects > 0, multiPick: picks >= 2 };
}

export function matchesOpinion(votes, filter) {
  return filter === 'all' || summarizeOpinions(votes)[filter] === true;
}
