import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';
import League from './League';

interface MatchAttributes {
  id: string;
  date: Date;
  location: string;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  score?: {
    home: number;
    away: number;
  };
  leagueId: string;
  homeTeamName: string;
  awayTeamName: string;
  homeTeamGoals?: number;
  awayTeamGoals?: number;
  start: Date;
  end: Date;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface MatchCreationAttributes extends Optional<MatchAttributes, 'id' | 'createdAt' | 'updatedAt'> {}

class Match extends Model<MatchAttributes, MatchCreationAttributes> implements MatchAttributes {
  public id!: string;
  public date!: Date;
  public location!: string;
  public status!: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  public score?: {
    home: number;
    away: number;
  };
  public leagueId!: string;
  public homeTeamName!: string;
  public awayTeamName!: string;
  public homeTeamGoals?: number;
  public awayTeamGoals?: number;
  public start!: Date;
  public end!: Date;
  public notes?: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;

  // Instance methods
  public readonly homeTeamUsers?: (typeof User)[];
  public readonly awayTeamUsers?: (typeof User)[];
  public readonly availableUsers?: (typeof User)[];
  public readonly league?: League;

  public async addHomeTeamUser(userId: string): Promise<void> {
    await (this as any).addHomeTeamUser(userId);
  }

  public async addAwayTeamUser(userId: string): Promise<void> {
    await (this as any).addAwayTeamUser(userId);
  }

  public async addHomeTeamUsers(userIds: string[]): Promise<void> {
    await (this as any).addHomeTeamUsers(userIds);
  }

  public async addAwayTeamUsers(userIds: string[]): Promise<void> {
    await (this as any).addAwayTeamUsers(userIds);
  }

  public async setHomeTeamUsers(userIds: string[]): Promise<void> {
    await (this as any).setHomeTeamUsers(userIds);
  }

  public async setAwayTeamUsers(userIds: string[]): Promise<void> {
    await (this as any).setAwayTeamUsers(userIds);
  }

  public async addAvailableUser(userId: string): Promise<void> {
    await (this as any).addAvailableUser(userId);
  }

  public async removeAvailableUser(userId: string): Promise<void> {
    await (this as any).removeAvailableUser(userId);
  }

  public async getLeague(): Promise<League> {
    return (this as any).getLeague();
  }

  // static associate(models: any) {
  //   Match.belongsTo(models.League, {
  //     foreignKey: 'leagueId',
  //     as: 'league',
  //   });

  //   Match.belongsToMany(models.User, {
  //     through: 'MatchHomeTeam',
  //     as: 'homeTeamPlayers',
  //     foreignKey: 'matchId',
  //   });

  //   Match.belongsToMany(models.User, {
  //     through: 'MatchAwayTeam',
  //     as: 'awayTeamPlayers',
  //     foreignKey: 'matchId',
  //   });

  //   Match.belongsToMany(models.User, {
  //     through: 'MatchAvailableUsers',
  //     as: 'availablePlayers',
  //     foreignKey: 'matchId',
  //   });
  // }
}

Match.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    date: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    location: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('scheduled', 'in_progress', 'completed', 'cancelled'),
      defaultValue: 'scheduled',
      allowNull: false,
    },
    score: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    leagueId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: League,
        key: 'id',
      },
    },
    homeTeamName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    awayTeamName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    homeTeamGoals: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    awayTeamGoals: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    start: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    end: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: 'Match',
    timestamps: true,
  }
);

export default Match; 