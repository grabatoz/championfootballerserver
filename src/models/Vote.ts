import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/database';
import User from './User';
import Match from './Match';

class Vote extends Model {
  declare id: string;
  declare matchId: string;
  declare byUserId: string;
  declare forUserId: string;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;

  // static associate(models: any) {
  //   Vote.belongsTo(models.Match, {
  //     foreignKey: 'matchId',
  //     as: 'votedMatch'
  //   });

  //   Vote.belongsTo(models.User, {
  //     foreignKey: 'byUserId',
  //     as: 'voter'
  //   });

  //   Vote.belongsTo(models.User, {
  //     foreignKey: 'forUserId',
  //     as: 'votedFor'
  //   });
  // }
}

Vote.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    matchId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: Match,
        key: 'id',
      },
    },
    byUserId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: User,
        key: 'id',
      },
    },
    forUserId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: User,
        key: 'id',
      },
    },
  },
  {
    sequelize,
    modelName: 'Vote',
  }
);

export default Vote; 