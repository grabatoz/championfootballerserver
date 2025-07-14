export interface Skills {
  dribbling: number;
  shooting: number;
  passing: number;
  pace: number;
  defending: number;
  physical: number;
}

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  age?: number | string;
  password?: string;
  gender?: string;
  level?:string;
  joinedLeagues?: League[];
  managedLeagues?: League[];
  homeTeamMatches?: Match[];
  awayTeamMatches?: Match[];
  availableMatches?: Match[];
  guestMatch?: Match | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  position?: string;
  style?: string;
  preferredFoot?: string;
  shirtNumber?: string;
  profilePicture?: string | null;
  positionType: string;
  skills?: Skills;
}

export interface AuthResponse {
  success: boolean;
  user?: User;
  token?: string;
  error?: string;
}

export interface ApiError {
  message: string;
  status?: number;
}

// Add these interfaces to avoid 'any' types
export interface League {
  id: string;
  name: string;
  inviteCode: string;
  createdAt: string;
  members: User[];
  administrators: User[];
  matches: Match[];
  active: boolean;
  maxGames: number;
  showPoints: boolean;
  adminId?: string;
}

export interface Match {
  id: string;
  date: string;
  location: string;
  status: string;
  homeTeamName: string;
  awayTeamName: string;
  homeTeamGoals?: number;
  awayTeamGoals?: number;
  availableUsers: User[];
  homeTeamUsers: User[];
  awayTeamUsers: User[];
  end: string;
  active: boolean;
} 