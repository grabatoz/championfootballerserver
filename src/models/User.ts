import { Model, DataTypes } from 'sequelize';

import  sequelize  from '../config/database';

export interface UserAttributes {
  id?: string;
  email: string;
  password?: string; // Make password optional
  firstName?: string;
  lastName?: string;
  age?: number;
  gender?: string;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  phone?: string | null;
  position?: string;
  positionType?: string;
  style?: string;
  preferredFoot?: string;
  shirtNumber?: string;
  profilePicture?: string;
  skills?: {
    dribbling: number;
    shooting: number;
    passing: number;
    pace: number;
    defending: number;
    physical: number;
  };
  xp?: number;
  resetCode?: string | null;
  resetCodeExpiry?: Date | null;
  provider: string | null;
  providerId: string | null;
  achievements?: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export class User extends Model<UserAttributes> implements UserAttributes {
  public id!: string;
  public email!: string;
  public password!: string;
  public firstName!: string;
  public lastName!: string;
  public age!: number;
  public gender!: string;
  public country!: string | null;
  public state!: string | null;
  public city!: string | null;
  public phone!: string | null;
  public position!: string;
  public positionType!: string;
  public style!: string;
  public preferredFoot!: string;
  public shirtNumber!: string;
  public profilePicture!: string;
  public skills!: {
    dribbling: number;
    shooting: number;
    passing: number;
    pace: number;
    defending: number;
    physical: number;
  };
  public xp!: number;
  public resetCode!: string | null;
  public resetCodeExpiry!: Date | null;
  public provider!: string | null;
  public providerId!: string | null;
  public achievements!: string[];
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;

  static associate(models: any) {
    User.belongsToMany(models.League, {
      through: 'LeagueMember',
      as: 'leagues',
      foreignKey: 'userId',
      otherKey: 'leagueId'
    });

    User.belongsToMany(models.League, {
      through: 'LeagueAdmin',
      as: 'administeredLeagues',
      foreignKey: 'userId',
      otherKey: 'leagueId'
    });

    User.belongsToMany(models.Match, {
  // Must match Match model association through 'UserHomeMatches'
  through: 'UserHomeMatches',
      as: 'homeTeamMatches',
      foreignKey: 'userId',
      otherKey: 'matchId'
    });

    User.belongsToMany(models.Match, {
  // Must match Match model association through 'UserAwayMatches'
  through: 'UserAwayMatches',
      as: 'awayTeamMatches',
      foreignKey: 'userId',
      otherKey: 'matchId'
    });

    User.belongsToMany(models.Match, {
  // Must match Match model association through 'UserMatchAvailability'
  through: 'UserMatchAvailability',
      as: 'availableMatches',
      foreignKey: 'userId',
      otherKey: 'matchId'
    });

    User.hasMany(models.Vote, { foreignKey: 'voterId', as: 'givenVotes' });
    User.hasMany(models.Vote, { foreignKey: 'votedForId', as: 'receivedVotes' });
    User.hasMany(models.MatchStatistics, { foreignKey: 'user_id', as: 'statistics' });
  }
}

User.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    firstName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    lastName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    password: {
      type: DataTypes.STRING,
      allowNull: true, // allow null for social accounts
    },
    age: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    gender: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    country: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    state: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    city: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    resetCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    resetCodeExpiry: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    position: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    positionType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    style: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    preferredFoot: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    shirtNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    profilePicture: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    skills: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {
        dribbling: 50,
        shooting: 50,
        passing: 50,
        pace: 50,
        defending: 50,
        physical: 50
      }
    },
    xp: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    achievements: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: [],
    },
    provider: {
      type: DataTypes.STRING,
      allowNull: true
    },
    providerId: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null
    }
  },
  {
    sequelize,
    tableName: 'users',
    timestamps: true,
  }
);

export default User;