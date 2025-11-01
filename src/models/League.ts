import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';
import User from './User';
import Match from './Match';

interface LeagueAttributes {
  id: string;
  name: string;
  inviteCode: string;
  maxGames?: number;
  active: boolean;
  showPoints: boolean;
  image?: string; // Added image field
  createdAt: Date;
  updatedAt: Date;
}


class League extends Model<LeagueAttributes> {
  declare id: string;
  declare name: string;
  declare inviteCode: string;
  declare maxGames?: number;
  declare active: boolean;
  declare showPoints: boolean;
  declare image?: string; // Added image field
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // Instance methods
  declare users: (typeof User)[];
  declare admins: (typeof User)[];
  declare matches: Match[];

  static associate(models: any) {
    League.belongsToMany(models.User, {
      through: 'LeagueMember',
      as: 'members',
      foreignKey: 'leagueId',
      otherKey: 'userId'
    });

    League.belongsToMany(models.User, {
      through: 'LeagueAdmin',
      as: 'administeredLeagues',
      foreignKey: 'leagueId',
      otherKey: 'userId'
    });

    League.hasMany(models.Match, {
      foreignKey: 'leagueId',
      as: 'matches'
    });
  }
}

League.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true, // prevent duplicate names at DB level (case-sensitive in Postgres)
    },
    inviteCode: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    maxGames: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    showPoints: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    image: {
      type: DataTypes.STRING,
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
    modelName: 'League',
    timestamps: true,
  }
);

export default League;
export type { LeagueAttributes };