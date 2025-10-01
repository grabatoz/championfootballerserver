import { Model, DataTypes, Optional } from 'sequelize';
import sequelize  from '../config/database';
import User from './User';
import League from './League';
import { Vote } from './Vote';

export interface MatchAttributes {
  id: string;
  date: Date;
  location: string;
  status?: 'SCHEDULED' | 'IN_PROGRESS' | 'RESULT_UPLOADED' | 'REVISION_REQUESTED' | 'RESULT_PUBLISHED';
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
  availableUsers?: User[];
  homeCaptainId?: string;
  awayCaptainId?: string;
  homeTeamImage?: string;
  awayTeamImage?: string;
  archived?: boolean; // <-- ADDED
  homeCaptainConfirmed?: boolean;
  awayCaptainConfirmed?: boolean;
  resultUploadedAt?: Date | null;
  resultPublishedAt?: Date | null;
  // optional captain revision suggestion
  suggestedHomeGoals?: number | null;
  suggestedAwayGoals?: number | null;
  suggestedByCaptainId?: string | null;
}

interface MatchCreationAttributes extends Optional<MatchAttributes, 'id' | 'archived'> {}

class Match extends Model<MatchAttributes, MatchCreationAttributes> implements MatchAttributes {
  public id!: string;
  public date!: Date;
  public location!: string;
  public status!: 'SCHEDULED' | 'IN_PROGRESS' | 'RESULT_UPLOADED' | 'REVISION_REQUESTED' | 'RESULT_PUBLISHED';
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
  public availableUsers?: User[];
  public homeCaptainId?: string;
  public awayCaptainId?: string;
  public homeTeamImage?: string;
  public awayTeamImage?: string;
  public archived?: boolean; // <-- ADDED
  public homeCaptainConfirmed?: boolean;
  public awayCaptainConfirmed?: boolean;
  public resultUploadedAt?: Date | null;
  public resultPublishedAt?: Date | null;
  public suggestedHomeGoals?: number | null;
  public suggestedAwayGoals?: number | null;
  public suggestedByCaptainId?: string | null;

  // Static associate function
  public static associate(models: any) {
    Match.belongsTo(models.League, {
      foreignKey: 'leagueId',
      as: 'league',
    });

    Match.belongsToMany(models.User, {
  // Join table for home team players
  through: 'UserHomeMatches',
      as: 'homeTeamUsers',
      foreignKey: 'matchId',
      otherKey: 'userId',
    });

    Match.belongsToMany(models.User, {
  // Join table for away team players
  through: 'UserAwayMatches',
      as: 'awayTeamUsers',
      foreignKey: 'matchId',
      otherKey: 'userId',
    });

    Match.belongsToMany(models.User, {
  // Availability join table
  through: 'UserMatchAvailability',
      as: 'availableUsers',
      foreignKey: 'matchId',
      otherKey: 'userId',
    });

    Match.belongsToMany(models.User, {
      through: 'UserMatchStatistics',
      as: 'statistics',
      foreignKey: 'matchId',
      otherKey: 'userId',
    });

    Match.hasMany(models.Vote, { foreignKey: 'matchId', as: 'votes' });

    Match.belongsTo(models.User, {
      as: 'homeCaptain',
      foreignKey: 'homeCaptainId',
    });

    Match.belongsTo(models.User, {
      as: 'awayCaptain',
      foreignKey: 'awayCaptainId',
    });
  }

  // Association methods
  public addAvailableUser = async (user: User): Promise<void> => {
    try {
      await sequelize.models.UserMatchAvailability.create({
        userId: user.id,
        matchId: this.id
      });
    } catch (error) {
      console.error('Error adding available user:', error);
      throw error;
    }
  };

  public removeAvailableUser = async (user: User): Promise<void> => {
    try {
      const result = await sequelize.models.UserMatchAvailability.destroy({
        where: {
          userId: user.id,
          matchId: this.id
        }
      });
      console.log(`Tried to remove availability for userId=${user.id}, matchId=${this.id}, result=${result}`);
    } catch (error) {
      console.error('Error removing available user:', error);
      throw error;
    }
  };

  public getAvailableUsers = async (): Promise<User[]> => {
    try {
      const availabilities = await sequelize.models.UserMatchAvailability.findAll({
        where: { matchId: this.id },
        include: [{
          model: User,
          as: 'user'
        }]
      });
      return availabilities.map(a => a.get('user') as User);
    } catch (error) {
      console.error('Error getting available users:', error);
      throw error;
    }
  };
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
    status: { type: DataTypes.ENUM('SCHEDULED','IN_PROGRESS','RESULT_UPLOADED','REVISION_REQUESTED','RESULT_PUBLISHED'), defaultValue: 'SCHEDULED' },
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
      allowNull: true,
    },
    awayTeamName: {
      type: DataTypes.STRING,
      allowNull: true,
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
    homeCaptainId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    awayCaptainId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    homeTeamImage: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    awayTeamImage: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    archived: { // <-- ADDED
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false
    },
    homeCaptainConfirmed: { type: DataTypes.BOOLEAN, defaultValue: false },
    awayCaptainConfirmed: { type: DataTypes.BOOLEAN, defaultValue: false },
    resultUploadedAt: { type: DataTypes.DATE, allowNull: true },
    resultPublishedAt: { type: DataTypes.DATE, allowNull: true },
    suggestedHomeGoals: { type: DataTypes.INTEGER, allowNull: true },
    suggestedAwayGoals: { type: DataTypes.INTEGER, allowNull: true },
    suggestedByCaptainId: { type: DataTypes.UUID, allowNull: true },
  },
  {
    sequelize,
    modelName: 'Match',
    timestamps: true,
  }
);

export default Match;