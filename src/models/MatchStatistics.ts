import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';
import User from './User';
import Match from './Match';

interface MatchStatisticsAttributes {
  id: string;
  user_id: string;
  match_id: string;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  minutesPlayed: number;
  rating: number;
  type?: string;
  value?: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MatchStatisticsCreationAttributes extends Optional<MatchStatisticsAttributes, 'id' | 'createdAt' | 'updatedAt'> {}

class MatchStatistics extends Model<MatchStatisticsAttributes, MatchStatisticsCreationAttributes> implements MatchStatisticsAttributes {
  public id!: string;
  public user_id!: string;
  public match_id!: string;
  public goals!: number;
  public assists!: number;
  public yellowCards!: number;
  public redCards!: number;
  public minutesPlayed!: number;
  public rating!: number;
  public type!: string;
  public value!: number;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;

  // Instance methods
  public readonly user?: any;
  public readonly match?: any;

  // static associate(models: any) {
  //   MatchStatistics.belongsTo(models.Match, {
  //     foreignKey: 'matchId',
  //     as: 'statisticsMatch'
  //   });

  //   MatchStatistics.belongsTo(models.User, {
  //     foreignKey: 'userId',
  //     as: 'statisticsPlayer'
  //   });
  // }
}

MatchStatistics.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: User,
        key: 'id',
      },
      field: 'user_id',
    },
    match_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: Match,
        key: 'id',
      },
      field: 'match_id',
    },
    goals: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    assists: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    yellowCards: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    redCards: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    minutesPlayed: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    rating: {
      type: DataTypes.FLOAT,
      defaultValue: 0,
    },
    type: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    value: {
      type: DataTypes.INTEGER,
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
    modelName: 'MatchStatistics',
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['user_id', 'match_id'],
        name: 'match_statistics_user_id_match_id_unique'
      },
    ],
  }
);

// Define associations
MatchStatistics.belongsTo(User, {
  foreignKey: 'user_id',
  as: 'user',
});

MatchStatistics.belongsTo(Match, {
  foreignKey: 'match_id',
  as: 'match',
});

export default MatchStatistics; 