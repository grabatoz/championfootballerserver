import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';
import League from './League';
import Match from './Match';
import User from './User';

interface SeasonAttributes {
  id: string;
  leagueId: string;
  seasonNumber: number;
  name: string;
  isActive: boolean;
  archived?: boolean;
  deleted?: boolean;
  startDate: Date;
  endDate?: Date;
  maxGames?: number;
  showPoints?: boolean;
  trophyAwardSnapshot?: Record<string, {
    winnerId: string | null;
    winner: string;
    awardedAt?: string | null;
    updatedAt?: string | null;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

interface SeasonCreationAttributes extends Optional<SeasonAttributes, 'id' | 'endDate' | 'createdAt' | 'updatedAt'> {}

class Season extends Model<SeasonAttributes, SeasonCreationAttributes> {
  declare id: string;
  declare leagueId: string;
  declare seasonNumber: number;
  declare name: string;
  declare isActive: boolean;
  declare archived?: boolean;
  declare deleted?: boolean;
  declare startDate: Date;
  declare endDate?: Date;
  declare maxGames?: number;
  declare showPoints?: boolean;
  declare trophyAwardSnapshot?: Record<string, {
    winnerId: string | null;
    winner: string;
    awardedAt?: string | null;
    updatedAt?: string | null;
  }>;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // Associations
  declare league: League;
  declare matches: Match[];
  declare players: User[];

  static associate(models: any) {
    Season.belongsTo(models.League, {
      foreignKey: 'leagueId',
      as: 'league'
    });

    Season.hasMany(models.Match, {
      foreignKey: 'seasonId',
      as: 'matches'
    });

    // Many-to-many relationship with users (players in this season)
    Season.belongsToMany(models.User, {
      through: 'SeasonPlayers',
      as: 'players',
      foreignKey: 'seasonId',
      otherKey: 'userId'
    });
  }
}

Season.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    leagueId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'Leagues',
        key: 'id'
      },
      onDelete: 'CASCADE'
    },
    seasonNumber: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    archived: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    deleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    startDate: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    endDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    maxGames: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    showPoints: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    },
    trophyAwardSnapshot: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
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
    tableName: 'Seasons',
    timestamps: true,
    indexes: [
      {
        name: 'seasons_league_id_season_number_active',
        unique: true,
        fields: ['leagueId', 'seasonNumber'],
        where: {
          deleted: false
        }
      },
      {
        fields: ['leagueId', 'isActive']
      }
    ]
  }
);

export default Season;
