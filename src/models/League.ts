import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';
import Match from './Match';
import userModel from './User';

interface LeagueAttributes {
  id: string;
  name: string;
  inviteCode: string;
  maxGames?: number;
  active: boolean;
  showPoints: boolean;
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
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // Instance methods
  declare users: (typeof userModel)[];
  declare admins: (typeof userModel)[];
  declare matches: Match[];

  public async addUser(userId: string): Promise<void> {
    await (this as any).addUser(userId);
  }

  public async addAdmin(userId: string): Promise<void> {
    await (this as any).addAdmin(userId);
  }

  public async setUsers(userIds: string[]): Promise<void> {
    await (this as any).setUsers(userIds);
  }

  public async setAdmins(userIds: string[]): Promise<void> {
    await (this as any).setAdmins(userIds);
  }

  public async addUsers(userIds: string[]): Promise<void> {
    await (this as any).addUsers(userIds);
  }

  public async addAdmins(userIds: string[]): Promise<void> {
    await (this as any).addAdmins(userIds);
  }

  public async removeUser(userId: string): Promise<void> {
    await (this as any).removeUser(userId);
  }

  static associate(models: any) {
    League.belongsToMany(models.User, {
      through: 'LeagueUsers',
      as: 'members',
      foreignKey: 'leagueId',
      otherKey: 'userId'
    });

    League.belongsToMany(models.User, {
      through: 'LeagueAdmins',
      as: 'administrators',
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