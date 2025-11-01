import { DataTypes, Model, Optional, Sequelize } from 'sequelize';
import sequelize from '../config/database';
export type MatchAvailabilityStatus = 'pending' | 'available' | 'unavailable';
interface MatchAvailabilityAttrs { 
   id: string;  match_id: string;  user_id: string;  status: MatchAvailabilityStatus;  last_reminder_at?: Date;  created_at: Date;  updated_at: Date;}type MatchAvailabilityCreation = Optional<MatchAvailabilityAttrs, 'id' | 'status' | 'last_reminder_at' | 'created_at' | 'updated_at'>;export class MatchAvailability extends Model<MatchAvailabilityAttrs, MatchAvailabilityCreation> implements MatchAvailabilityAttrs {  public id!: string;  public match_id!: string;  public user_id!: string;  public status!: MatchAvailabilityStatus;  public last_reminder_at?: Date;  public created_at!: Date;  public updated_at!: Date;  static initModel(sequelizeInstance: Sequelize) {    MatchAvailability.init({      id: {        type: DataTypes.UUID,        defaultValue: DataTypes.UUIDV4,        primaryKey: true      },      match_id: {        type: DataTypes.UUID,        allowNull: false      },      user_id: {        type: DataTypes.UUID,        allowNull: false      },      status: {        type: DataTypes.ENUM('pending', 'available', 'unavailable'),        allowNull: false,        defaultValue: 'pending'      },      last_reminder_at: {        type: DataTypes.DATE,
        allowNull: true
      },
      created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
      },
      updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
      }
    }, {
      sequelize: sequelizeInstance,
      tableName: 'match_availabilities',
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    });
    return MatchAvailability;
  }
}

export default MatchAvailability;
