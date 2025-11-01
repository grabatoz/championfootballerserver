import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/database';

interface MatchGuestAttributes {
  id: string;
  matchId: string;
  team: 'home' | 'away';
  firstName: string;
  lastName: string;
  shirtNumber?: string;
}

interface MatchGuestCreationAttributes extends Optional<MatchGuestAttributes, 'id'> {}


class MatchGuest extends Model<MatchGuestAttributes, MatchGuestCreationAttributes>
  implements MatchGuestAttributes {
  public id!: string;
  public matchId!: string;
  public team!: 'home' | 'away';
  public firstName!: string;
  public lastName!: string;
  public shirtNumber?: string;

  // no associations here; wire them in models/index.ts
}

MatchGuest.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    matchId: { type: DataTypes.UUID, allowNull: false },
    team: { type: DataTypes.ENUM('home', 'away'), allowNull: false },
    firstName: { type: DataTypes.STRING, allowNull: false },
    lastName: { type: DataTypes.STRING, allowNull: false },
    shirtNumber: { type: DataTypes.STRING, allowNull: true },
  },
  { sequelize, modelName: 'MatchGuest', tableName: 'MatchGuests', timestamps: true }
);

export default MatchGuest;
export type { MatchGuestAttributes };