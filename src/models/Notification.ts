import { DataTypes, Model, Optional, Sequelize } from 'sequelize';
import sequelize from '../config/database';

export interface NotificationAttributes {
  id: string;
  user_id?: string | null;
  type: string;
  title: string;
  body: string;
  meta?: any;
  read: boolean;
  created_at: Date;
}


type NotificationCreationAttributes = Optional<NotificationAttributes, 'id' | 'user_id'>;

class Notification extends Model<NotificationAttributes, NotificationCreationAttributes> implements NotificationAttributes {
  public id!: string;
  public user_id?: string | null;
  public type!: string;
  public title!: string;
  public body!: string;
  public meta?: any;
  public read!: boolean;
  public created_at!: Date;

  static initModel(sequelizeInstance: Sequelize) {
    Notification.init({
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },
      user_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      type: {
        type: DataTypes.STRING,
        allowNull: false
      },
      title: {
        type: DataTypes.STRING,
        allowNull: false
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: false
      },
      meta: {
        type: DataTypes.JSONB,
        allowNull: true
      },
      read: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
      }
    }, {
      sequelize: sequelizeInstance,
      tableName: 'notifications',
      underscored: true,
      timestamps: false
    });
    return Notification;
  }

  // REMOVED static bulkCreate override - use the inherited one from Model
}

// Initialize model immediately
Notification.initModel(sequelize);

export default Notification;