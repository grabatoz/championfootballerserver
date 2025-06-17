import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';

interface SessionAttributes {
  id: string;
  userId: string;
  ipAddress?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface SessionCreationAttributes extends Optional<SessionAttributes, 'id' | 'ipAddress' | 'createdAt' | 'updatedAt'> {}

class Session extends Model<SessionAttributes, SessionCreationAttributes> implements SessionAttributes {
  public id!: string;
  public userId!: string;
  public ipAddress!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;

  // static associate(models: any) {
  //   Session.belongsTo(models.User, {
  //     foreignKey: 'userId',
  //     as: 'user'
  //   });
  // }
}

Session.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: User,
        key: 'id',
      },
    },
    ipAddress: {
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
    modelName: 'Session',
  }
);

export default Session; 