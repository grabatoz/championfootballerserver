import {
  Model,
  DataTypes,
  Sequelize,
  Optional,
} from 'sequelize';
import sequelize from '../config/database';
import bcrypt from 'bcrypt';
import Match from './Match';
import League from './League';

// 1. Attributes interface
interface UserAttributes {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  age?: number;
  gender?: string;
  ipAddress?: string;
  pictureKey?: string;
  chemistryStyle?: string;
  displayName?: string;
  position?: string;
  preferredFoot?: string;
  shirtNumber?: number;
  attributes?: {
    Pace: number;
    Passing: number;
    Physical: number;
    Shooting: number;
    Defending: number;
    Dribbling: number;
  };
  matchGuestForId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// 2. Creation interface (used for `create`)
interface UserCreationAttributes extends Optional<UserAttributes, 'id' | 'createdAt' | 'updatedAt'> {}

// 3. Define class
class User extends Model<UserAttributes, UserCreationAttributes> implements UserAttributes {
  public id!: string;
  public firstName!: string;
  public lastName!: string;
  public email!: string;
  public password!: string;
  public age?: number;
  public gender?: string;
  public ipAddress?: string;
  public pictureKey?: string;
  public chemistryStyle?: string;
  public displayName?: string;
  public position?: string;
  public preferredFoot?: string;
  public shirtNumber?: number;
  public attributes?: {
    Pace: number;
    Passing: number;
    Physical: number;
    Shooting: number;
    Defending: number;
    Dribbling: number;
  };
  public matchGuestForId?: string;

  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;

  // Associations
  public readonly memberLeagues?: League[];
  public readonly administeredLeagues?: League[];
  public readonly homeTeamMatches?: Match[];
  public readonly awayTeamMatches?: Match[];
  public readonly availableMatches?: Match[];
  public readonly guestMatch?: Match;

  // Instance method
  public async validatePassword(password: string): Promise<boolean> {
    return bcrypt.compare(password, this.password);
  }

  // Static associate function
  public static associate(models: any) {
    User.belongsToMany(models.League, {
      through: 'LeagueUsers',
      as: 'joinedLeagues',
      foreignKey: 'userId',
      otherKey: 'leagueId',
    });

    User.belongsToMany(models.League, {
      through: 'LeagueAdmins',
      as: 'managedLeagues',
      foreignKey: 'userId',
      otherKey: 'leagueId',
    });

    User.belongsToMany(models.Match, {
      through: 'UserHomeMatches',
      as: 'homeTeamMatches',
      foreignKey: 'userId',
      otherKey: 'matchId',
    });

    User.belongsToMany(models.Match, {
      through: 'UserAwayMatches',
      as: 'awayTeamMatches',
      foreignKey: 'userId',
      otherKey: 'matchId',
    });

    User.belongsToMany(models.Match, {
      through: 'UserMatchAvailability',
      as: 'availableMatches',
      foreignKey: 'userId',
      otherKey: 'matchId',
    });

    User.belongsTo(models.Match, {
      foreignKey: 'matchGuestForId',
      as: 'guestMatch',
    });
  }
}

// 4. Init model
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
    age: DataTypes.INTEGER,
    gender: DataTypes.STRING,
    ipAddress: DataTypes.STRING,
    pictureKey: DataTypes.STRING,
    chemistryStyle: DataTypes.STRING,
    displayName: DataTypes.STRING,
    position: DataTypes.STRING,
    preferredFoot: DataTypes.STRING,
    shirtNumber: DataTypes.INTEGER,
    attributes: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    matchGuestForId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: Match,
        key: 'id',
      },
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('NOW()'),
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('NOW()'),
    },
  },
  {
    sequelize,
    modelName: 'User',
    tableName: 'Users',
    timestamps: true,
    hooks: {
      beforeCreate: async (user: User) => {
        if (user.password) {
          const salt = await bcrypt.genSalt(10);
          user.password = await bcrypt.hash(user.password, salt);
        }
      },
      beforeUpdate: async (user: User) => {
        if (user.changed('password')) {
          const salt = await bcrypt.genSalt(10);
          user.password = await bcrypt.hash(user.password, salt);
        }
      },
    },
  }
);

export default User;






























// import { Model, DataTypes, Sequelize } from 'sequelize';
// import sequelize from '../config/database';
// import bcrypt from 'bcrypt';
// import Match from './Match';
// import League from './League';

// interface UserAttributes {
//   id: string;
//   firstName: string;
//   lastName: string;
//   email: string;
//   password: string;
//   age?: number;
//   gender?: string;
//   ipAddress?: string;
//   pictureKey?: string;
//   chemistryStyle?: string;
//   displayName?: string;
//   position?: string;
//   preferredFoot?: string;
//   shirtNumber?: number;
//   attributes?: {
//     Pace: number;
//     Passing: number;
//     Physical: number;
//     Shooting: number;
//     Defending: number;
//     Dribbling: number;
//   };
//   matchGuestForId?: string;
//   createdAt: Date;
//   updatedAt: Date;
// }

// interface UserCreationAttributes extends Omit<UserAttributes, 'id' | 'createdAt' | 'updatedAt'> {}

// class User extends Model<UserAttributes, UserCreationAttributes> {
//   declare id: string;
//   declare firstName: string;
//   declare lastName: string;
//   declare email: string;
//   declare password: string;
//   declare age?: number;
//   declare gender?: string;
//   declare ipAddress?: string;
//   declare pictureKey?: string;
//   declare chemistryStyle?: string;
//   declare displayName?: string;
//   declare position?: string;
//   declare preferredFoot?: string;
//   declare shirtNumber?: number;
//   declare attributes?: {
//     Pace: number;
//     Passing: number;
//     Physical: number;
//     Shooting: number;
//     Defending: number;
//     Dribbling: number;
//   };
//   declare matchGuestForId?: string;
//   declare readonly createdAt: Date;
//   declare readonly updatedAt: Date;

//   // Instance methods
//   declare readonly memberLeagues?: League[];
//   declare readonly administeredLeagues?: League[];
//   declare readonly homeTeamMatches?: Match[];
//   declare readonly awayTeamMatches?: Match[];
//   declare readonly availableMatches?: Match[];
//   declare readonly guestMatch?: Match;

//   public async validatePassword(password: string): Promise<boolean> {
//     return bcrypt.compare(password, this.password);
//   }

//   static associate(models: any) {
//     // User-League associations
//     User.belongsToMany(models.League, {
//       through: 'LeagueUsers',
//       as: 'joinedLeagues',
//       foreignKey: 'userId',
//       otherKey: 'leagueId'
//     });

//     User.belongsToMany(models.League, {
//       through: 'LeagueAdmins',
//       as: 'managedLeagues',
//       foreignKey: 'userId',
//       otherKey: 'leagueId'
//     });

//     // Match associations
//     User.belongsToMany(models.Match, {
//       through: 'UserHomeMatches',
//       as: 'homeTeamMatches',
//       foreignKey: 'userId',
//       otherKey: 'matchId'
//     });

//     User.belongsToMany(models.Match, {
//       through: 'UserAwayMatches',
//       as: 'awayTeamMatches',
//       foreignKey: 'userId',
//       otherKey: 'matchId'
//     });

//     User.belongsToMany(models.Match, {
//       through: 'UserMatchAvailability',
//       as: 'availableMatches',
//       foreignKey: 'userId',
//       otherKey: 'matchId'
//     });

//     // Match guest relationship
//     User.belongsTo(models.Match, {
//       foreignKey: 'matchGuestForId',
//       as: 'guestMatch'
//     });
//   }
// }

// const userModel = User.init(
//   {
//     id: {
//       type: DataTypes.UUID,
//       defaultValue: DataTypes.UUIDV4,
//       primaryKey: true,
//     },
//     firstName: {
//       type: DataTypes.STRING,
//       allowNull: false,
//     },
//     lastName: {
//       type: DataTypes.STRING,
//       allowNull: false,
//     },
//     email: {
//       type: DataTypes.STRING,
//       allowNull: false,
//       unique: true,
//     },
//     password: {
//       type: DataTypes.STRING,
//       allowNull: false,
//     },
//     age: {
//       type: DataTypes.INTEGER,
//       allowNull: true,
//     },
//     gender: {
//       type: DataTypes.STRING,
//       allowNull: true,
//     },
//     ipAddress: {
//       type: DataTypes.STRING,
//       allowNull: true,
//     },
//     pictureKey: {
//       type: DataTypes.STRING,
//       allowNull: true,
//     },
//     chemistryStyle: {
//       type: DataTypes.STRING,
//       allowNull: true,
//     },
//     displayName: {
//       type: DataTypes.STRING,
//       allowNull: true,
//     },
//     position: {
//       type: DataTypes.STRING,
//       allowNull: true,
//     },
//     preferredFoot: {
//       type: DataTypes.STRING,
//       allowNull: true,
//     },
//     shirtNumber: {
//       type: DataTypes.INTEGER,
//       allowNull: true,
//     },
//     attributes: {
//       type: DataTypes.JSONB,
//       allowNull: true,
//     },
//     matchGuestForId: {
//       type: DataTypes.UUID,
//       allowNull: true,
//       references: {
//         model: Match,
//         key: 'id',
//       },
//     },
//     createdAt: {
//       type: DataTypes.DATE,
//       allowNull: false,
//     },
//     updatedAt: {
//       type: DataTypes.DATE,
//       allowNull: false,
//     },
//   },
//   {
//     sequelize,
//     modelName: 'User',
//     timestamps: true,
//     hooks: {
//       beforeCreate: async (user: User) => {
//         if (user.password) {
//           const salt = await bcrypt.genSalt(10);
//           user.password = await bcrypt.hash(user.password, salt);
//         }
//       },
//       beforeUpdate: async (user: User) => {
//         if (user.changed('password')) {
//           const salt = await bcrypt.genSalt(10);
//           user.password = await bcrypt.hash(user.password, salt);
//         }
//       },
//     },
//   }
// );

// export default userModel;