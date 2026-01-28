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
  startDate: Date;
  endDate?: Date;
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
  declare startDate: Date;
  declare endDate?: Date;
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
    startDate: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    endDate: {
      type: DataTypes.DATE,
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
    tableName: 'Seasons',
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ['leagueId', 'seasonNumber']
      },
      {
        fields: ['leagueId', 'isActive']
      }
    ]
  }
);

export default Season;
