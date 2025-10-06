import { Context, Next } from 'koa';

// Types describing the data you need from storage
type MatchStatus = 'RESULT_UPLOADED' | 'RESULT_PUBLISHED' | string;

interface MatchBasic {
  id: string;
  leagueId: string;
  start?: string | Date;
  status: MatchStatus;
}

interface PlayedMatch extends MatchBasic {}

// Replace these with your real data access helpers (keep throw, but add return types)
async function getMatchById(matchId: string): Promise<MatchBasic | null> {
  // return { id, leagueId, start, status }
  throw new Error('implement getMatchById');
}
async function listPlayedMatchesByLeague(leagueId: string): Promise<PlayedMatch[]> {
  // return matches for the league; each item must include id, status, start
  throw new Error('implement listPlayedMatchesByLeague');
}
async function isLeagueAdmin(userId: string, leagueId: string): Promise<boolean> {
  // true if user is an admin for the league
  throw new Error('implement isLeagueAdmin');
}

function sortByStartAsc(arr: PlayedMatch[]): PlayedMatch[] {
  return [...arr].sort(
    (a, b) => new Date(a.start ?? 0).getTime() - new Date(b.start ?? 0).getTime()
  );
}

const RESULTS_STATES: ReadonlySet<string> = new Set(['RESULT_UPLOADED', 'RESULT_PUBLISHED']);

export async function getStatsWindow(ctx: Context) {
  try {
    const matchId = ctx.params.matchId || ctx.params.id;
    const userId = ctx.state.user?.id as string | undefined;

    const match = await getMatchById(matchId);
    if (!match) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }

    const playedRaw = await listPlayedMatchesByLeague(match.leagueId);
    const played = sortByStartAsc(playedRaw.filter(m => RESULTS_STATES.has(m.status)));
    const idx = played.findIndex(m => m.id === matchId);

    const indexFromEnd = idx >= 0 ? (played.length - 1 - idx) : null; // 0=current(latest), 1=previous
    const isWithinLastTwo = indexFromEnd !== null && indexFromEnd <= 1;
    const isOlderThanTwo = indexFromEnd !== null && indexFromEnd > 1;
    const resultsUploaded = RESULTS_STATES.has(match.status);
    const canPlayerSubmit = resultsUploaded && isWithinLastTwo;

    const admin = userId ? await isLeagueAdmin(userId, match.leagueId) : false;

    ctx.body = {
      success: true,
      window: {
        resultsUploaded,
        isWithinLastTwo,
        isOlderThanTwo,
        canPlayerSubmit,
        adminCanSubmit: true,
        isAdmin: admin,
        indexFromEnd, // add this
      },
    };
  } catch (e: any) {
    ctx.status = 500;
    ctx.body = { success: false, message: e?.message || 'Server error' };
  }
}

// Guard to use before POST /matches/:matchId/stats
export async function enforceStatsWindow(ctx: Context, next: Next) {
  try {
    const matchId = ctx.params.matchId || ctx.params.id;
    const userId = ctx.state.user?.id as string | undefined;

    if (!userId) {
      ctx.status = 401;
      ctx.body = { success: false, message: 'Unauthorized' };
      return;
    }

    const match = await getMatchById(matchId);
    if (!match) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }

    const admin = await isLeagueAdmin(userId, match.leagueId);
    if (admin) {
      await next();
      return;
    }

    const playedRaw = await listPlayedMatchesByLeague(match.leagueId);
    const played = sortByStartAsc(playedRaw.filter(m => RESULTS_STATES.has(m.status)));
    const idx = played.findIndex(m => m.id === matchId);
    const isWithinLastTwo = idx >= 0 && idx >= played.length - 2;
    const resultsUploaded = RESULTS_STATES.has(match.status);

    if (resultsUploaded && isWithinLastTwo) {
      await next();
      return;
    }

    ctx.status = 403;
    ctx.body = {
      success: false,
      message:
        "It's not possible to add stats for earlier games. Please ask the admin to make changes to older games.",
    };
  } catch (e: any) {
    ctx.status = 500;
    ctx.body = { success: false, message: e?.message || 'Server error' };
  }
}