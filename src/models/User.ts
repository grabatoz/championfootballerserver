import { Model, DataTypes } from 'sequelize';
import  sequelize  from '../config/database';

export interface UserAttributes {
  id?: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  age?: number;
  gender?: string;
  position?: string;
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
  createdAt?: Date;
  updatedAt?: Date;
}

export class User extends Model<UserAttributes> implements UserAttributes {
  public id!: string;
  public firstName!: string;
  public lastName!: string;
  public email!: string;
  public password!: string;
  public age!: number;
  public gender!: string;
  public position!: string;
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
      through: 'MatchHomeTeam',
      as: 'homeTeamMatches',
      foreignKey: 'userId',
      otherKey: 'matchId'
    });

    User.belongsToMany(models.Match, {
      through: 'MatchAwayTeam',
      as: 'awayTeamMatches',
      foreignKey: 'userId',
      otherKey: 'matchId'
    });

    User.belongsToMany(models.Match, {
      through: 'MatchAvailability',
      as: 'availableMatches',
      foreignKey: 'userId',
      otherKey: 'matchId'
    });

    User.hasMany(models.Vote, { foreignKey: 'voterId', as: 'givenVotes' });
    User.hasMany(models.Vote, { foreignKey: 'votedForId', as: 'receivedVotes' });
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
      allowNull: false,
    },
    age: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    gender: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    position: {
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
    }
  },
  {
    sequelize,
    tableName: 'users',
    timestamps: true,
  }
);

export default User;