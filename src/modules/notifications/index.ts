import { League, User } from '../../models';
import Notification from '../../models/Notification';

export type NotificationType =
  | 'MATCH_CREATED'
  | 'MATCH_UPDATED'
  | 'TEAM_SELECTION'
  | 'AVAILABILITY_REMINDER'
  | 'RESULT_PUBLISHED'
  | 'RESULT_CONFIRMATION_REQUEST'
  | 'CAPTAIN_CONFIRMED'
  | 'CAPTAIN_REVISION_SUGGESTED'
  | 'MATCH_ENDED'
  | 'MOTM_VOTE'
  | 'GENERAL';

  
// Safe helper: returns league admins (no role filter on the pivot)
async function getLeagueAdmins(leagueId: string): Promise<Array<{ id: string }>> {
  try {
    // Detect the League↔User association alias once
    const assoc =
      (League as any).associations?.admins ||
      (League as any).associations?.administrators ||
      (League as any).associations?.members ||
      (League as any).associations?.users;

    // Build a safe attribute list from model attributes only
    const available = Object.keys((League as any).rawAttributes || {});
    const hintCandidates = ['ownerId', 'createdByUserId', 'adminUserId', 'owner_id', 'created_by_user_id', 'admin_user_id'];
    const safeHintAttrs = hintCandidates.filter((k) => available.includes(k));
    const attrs = ['id', ...safeHintAttrs];

    // Fetch owner/creator/admin hint IDs if present on the model
    const adminHints = new Set<string>();
    if (attrs.length > 1) {
      const leagueRow = await League.findByPk(leagueId, { attributes: attrs } as any);
      if (leagueRow) {
        const lr: any = leagueRow;
        for (const k of safeHintAttrs) {
          const v = lr[k];
          if (v) adminHints.add(String(v));
        }
      }
    }

    if (!assoc) {
      // No association available; use hints only
      return Array.from(adminHints).map((id) => ({ id }));
    }

    // Include users via the detected alias; no through.where (role may not exist)
    const include: any = {
      association: assoc,
      attributes: ['id'],
      through: { attributes: [] },
    };

    const league = await League.findByPk(leagueId, { include: [include] } as any);
    if (!league) return Array.from(adminHints).map((id) => ({ id }));

    const related = ((league as any)[assoc.as] ?? []) as Array<{ id: string }>;

    // Prefer owner/creator/adminUser hints if they intersect with related users
    const byHints = related.filter((u: any) => adminHints.has(String(u.id)));
    if (byHints.length > 0) {
      return byHints.map((u: any) => ({ id: String(u.id) }));
    }

    // If association is explicit admins/administrators, return them directly
    if (assoc.as === 'admins' || assoc.as === 'administrators') {
      return related.map((u: any) => ({ id: String(u.id) }));
    }

    // Otherwise can’t distinguish admins; return empty
    return [];
  } catch (err) {
    console.error('getLeagueAdmins error', err);
    return [];
  }
}

export async function sendCaptainConfirmations(match: any, league: any) {
  const meta = {
    matchId: String(match.id),
    leagueId: String(league?.id ?? match.leagueId ?? ''),
    homeGoals: match.homeTeamGoals ?? null,
    awayGoals: match.awayTeamGoals ?? null,
  };
  const items = [
    match?.homeCaptainId && {
      userId: match.homeCaptainId,
      type: 'RESULT_CONFIRMATION_REQUEST' as const,
      title: 'Confirm result',
      body: `${match.homeTeamName} ${match.homeTeamGoals ?? ''} - ${match.awayTeamGoals ?? ''} ${match.awayTeamName}`,
      meta,
    },
    match?.awayCaptainId && {
      userId: match.awayCaptainId,
      type: 'RESULT_CONFIRMATION_REQUEST' as const,
      title: 'Confirm result',
      body: `${match.homeTeamName} ${match.homeTeamGoals ?? ''} - ${match.awayTeamGoals ?? ''} ${match.awayTeamName}`,
      meta,
    },
  ].filter(Boolean) as Array<{ userId: string; type: NotificationType; title: string; body: string; meta: any }>;

  for (const it of items) {
    await (Notification as any).create({
      user_id: it.userId,
      type: it.type,
      title: it.title,
      body: it.body,
      meta: it.meta,
    });
  }
}

export async function notifyCaptainConfirmed(match: any, captainId: string) {
  const meta = { matchId: String(match.id), leagueId: String(match.leagueId ?? '') };
  await (Notification as any).create({
    user_id: captainId,
    type: 'CAPTAIN_CONFIRMED',
    title: 'Result confirmed',
    body: 'Thanks for confirming the match result.',
    meta,
  });
}

export async function notifyCaptainRevision(match: any, captainId: string, homeGoals: number, awayGoals: number) {
  // Sends only to league admins (not to captains)
  const meta = {
    matchId: String(match.id),
    leagueId: String(match.leagueId ?? ''),
    homeGoals,
    awayGoals,
  };
  const admins = await getLeagueAdmins(match.leagueId);
  for (const admin of admins) {
    await (Notification as any).create({
      user_id: admin.id,
      type: 'CAPTAIN_REVISION_SUGGESTED',
      title: 'Revision suggested',
      body: `Captain suggests ${homeGoals}-${awayGoals} for ${match.homeTeamName} vs ${match.awayTeamName}`,
      meta,
    });
  }
}

/**
 * Send match ended notification to players
 * Called when a match time has ended to notify all available players
 */
export async function notifyMatchEnded(match: any, userIds: string[]) {
  const meta = {
    matchId: String(match.id),
    leagueId: String(match.leagueId ?? ''),
    matchEndTime: match.end?.toISOString?.() ?? new Date().toISOString(),
  };

  for (const userId of userIds) {
    try {
      await (Notification as any).create({
        user_id: userId,
        type: 'MATCH_ENDED',
        title: '⏰ Match Has Ended!',
        body: `The match "${match.homeTeamName} vs ${match.awayTeamName}" at ${match.location} has ended. Thank you for participating!`,
        meta,
        read: false,
        created_at: new Date(),
      });
    } catch (error) {
      console.error(`Failed to send match ended notification to user ${userId}:`, error);
    }
  }
}