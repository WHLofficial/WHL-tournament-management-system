// 审计留痕（排期 #10）：比赛域操作记录，落 0001 预留的 audit_log 表。
// 返回 INSERT 语句由调用方并入主 db.batch 同事务提交——审计与业务写入要么同时生效，
// 要么一起回滚（finish 的 409 场景见 scoring.ts：审计语句放 followUp 批次，
// 晋级冲突回滚终场时审计一并落空，不记脏账）。
export function auditStmt(
  db: D1Database,
  actorUserId: number,
  action: string,
  targetId: number,
  detail: unknown
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json)
       VALUES (?, ?, 'match', ?, ?)`
    )
    .bind(actorUserId, action, targetId, JSON.stringify(detail ?? null));
}
