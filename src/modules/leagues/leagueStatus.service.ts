import db from '../../models'
import { Op } from 'sequelize'
import sequelize from '../../config/database'

export const leagueStatusService = {
  async compute(leagueId: string) {
    const models = db as unknown as Record<string, any>
    const { League, User, Match, MatchStatistics } = models

    
    // Helpers
    const getKeys = (model: any) => Object.keys(model?.rawAttributes ?? {})
    const pickKey = (model: any, candidates: string[]) => {
      const keys = getKeys(model)
      return candidates.find((c) => keys.includes(c)) ?? null
    }

    // League + members
    const league = await League.findByPk(leagueId, {
      include: [{ model: User, as: 'members', attributes: ['id'] }],
    })
    if (!league) throw new Error('League not found')

    const memberIds = new Set<string>(((league as any).members ?? []).map((m: any) => String(m.id)))
    const maxGames: number = (league as any).maxGames ?? 0

    // All active matches for the league (ignore archived ones)
    const matches = await Match.findAll({
      where: { leagueId, archived: false },
      attributes: ['id'],
      raw: true,
    })
    const matchIds = matches.map((m: any) => String(m.id))
    if (matchIds.length === 0) {
      return {
        isComplete: maxGames === 0,
        totals: { members: memberIds.size, membersWithStats: 0, membersWithMaxGames: 0, maxGames },
        missing: [],
      }
    }

    // Participants per match via join tables
    const participantsByMatch = new Map<string, Set<string>>()
    const addParticipant = (mid: string, uid: string) => {
      if (!memberIds.has(uid)) return
      const set = participantsByMatch.get(mid) ?? new Set<string>()
      set.add(uid)
      participantsByMatch.set(mid, set)
    }

    const UserHomeMatches = (sequelize.models as any)?.UserHomeMatches
    const UserAwayMatches = (sequelize.models as any)?.UserAwayMatches
    if (UserHomeMatches) {
      const homeRows = await UserHomeMatches.findAll({
        where: { matchId: { [Op.in]: matchIds as any } },
        attributes: ['matchId', 'userId'],
        raw: true,
      })
      for (const r of homeRows as any[]) addParticipant(String(r.matchId), String(r.userId))
    }
    if (UserAwayMatches) {
      const awayRows = await UserAwayMatches.findAll({
        where: { matchId: { [Op.in]: matchIds as any } },
        attributes: ['matchId', 'userId'],
        raw: true,
      })
      for (const r of awayRows as any[]) addParticipant(String(r.matchId), String(r.userId))
    }

    // Stats rows from MatchStatistics (using underscored field names in your model)
    const statsByUser = new Map<string, Set<string>>()
    const statsByMatch = new Map<string, Set<string>>()
    const msMatchKey = pickKey(MatchStatistics, ['match_id', 'matchId'])
    const msUserKey = pickKey(MatchStatistics, ['user_id', 'userId'])
    if (msMatchKey && msUserKey) {
      const statRows = await MatchStatistics.findAll({
        where: { [msMatchKey]: { [Op.in]: matchIds as any } },
        attributes: [msMatchKey, msUserKey],
        raw: true,
      })
      for (const r of statRows as any[]) {
        const mid = String(r[msMatchKey])
        const uid = String(r[msUserKey])
        if (!memberIds.has(uid)) continue
        const setU = statsByUser.get(uid) ?? new Set<string>()
        setU.add(mid)
        statsByUser.set(uid, setU)
        const setM = statsByMatch.get(mid) ?? new Set<string>()
        setM.add(uid)
        statsByMatch.set(mid, setM)
      }
    }

    // Build per-match missing: for each participant, if they have no stats for that match -> missing
    const missing: Array<{ userId: string; matchId: string; reason: 'stats-missing' }> = []
    const participantsAll = new Set<string>()
    for (const [mid, set] of participantsByMatch.entries()) {
      const statsSet = statsByMatch.get(mid) ?? new Set<string>()
      for (const uid of set) {
        participantsAll.add(uid)
        if (!statsSet.has(uid)) missing.push({ userId: uid, matchId: mid, reason: 'stats-missing' })
      }
    }

    // Totals only across participants
    let membersWithStats = 0
    let membersWithMaxGames = 0
    for (const uid of participantsAll) {
      const games = (statsByUser.get(uid)?.size ?? 0)
      if (games > 0) membersWithStats++
      if (maxGames === 0 || games >= maxGames) membersWithMaxGames++
    }

  // Consider league complete when there are no per-match missing stats for participants.
  // If you still want to enforce maxGames for everyone, re-enable the condition below.
  // const isComplete = missing.length === 0 && (maxGames === 0 || membersWithMaxGames === participantsAll.size)
  const isComplete = missing.length === 0

    return {
      isComplete,
      totals: { members: memberIds.size, membersWithStats, membersWithMaxGames, maxGames },
      missing,
    }
  },
} 