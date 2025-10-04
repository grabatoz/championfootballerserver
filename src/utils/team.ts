export type Team = 'home' | 'away';
export const normalizeTeam = (t: any): Team =>
  String(t).toLowerCase() === 'away' ? 'away' : 'home';