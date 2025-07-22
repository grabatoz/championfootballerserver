import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';

interface MatchStatisticsAttributes {
  id: string;
  user_id: string;
  match_id: string;
  goals: number;
  assists: number;
  cleanSheets: number;
  penalties: number;
  freeKicks: number;
  yellowCards: number;
  redCards: number;
  defence: number;
  impact: number;
  minutesPlayed: number;
  rating: number;
  type?: string;
  value?: number;
  xpAwarded: number;
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
  public cleanSheets!: number;
  public penalties!: number;
  public freeKicks!: number;
  public yellowCards!: number;
  public redCards!: number;
  public defence!: number;
  public impact!: number;
  public minutesPlayed!: number;
  public rating!: number;
  public type!: string;
  public value!: number;
  public xpAwarded!: number;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;

  // Instance methods
  public readonly user?: any;
  public readonly match?: any;

  static associate(models: any) {
    MatchStatistics.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'user'
    });

    MatchStatistics.belongsTo(models.Match, {
      foreignKey: 'match_id',
      as: 'match'
    });
  }
}

MatchStatistics.init(
  {
    id: {
      type: DataTypes.UUID, // ✅ This is the fix
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },    
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    match_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'Matches',
        key: 'id'
      }
    },
    goals: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    assists: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    cleanSheets: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    penalties: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    freeKicks: {
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
    impact: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    defence: {
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
    xpAwarded: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
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

export default MatchStatistics; 