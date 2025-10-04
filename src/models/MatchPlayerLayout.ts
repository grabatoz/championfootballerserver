import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/database'; // adjust to your sequelize instance path

type Team = 'home'|'away';

export interface MatchPlayerLayoutAttrs {
  matchId: string;
  userId: string;
  team: Team;
  x: number;
  y: number;
}
type Creation = Optional<MatchPlayerLayoutAttrs, never>;

export class MatchPlayerLayout extends Model<MatchPlayerLayoutAttrs, Creation> implements MatchPlayerLayoutAttrs {
  public matchId!: string;
  public userId!: string;
  public team!: Team;
  public x!: number;
  public y!: number;
}

MatchPlayerLayout.init(
  {
    matchId: { type: DataTypes.STRING, allowNull: false, primaryKey: true },
    userId:  { type: DataTypes.STRING, allowNull: false, primaryKey: true },
    team:    { type: DataTypes.ENUM('home','away'), allowNull: false },
    x:       { type: DataTypes.FLOAT, allowNull: false },
    y:       { type: DataTypes.FLOAT, allowNull: false },
  },
  { sequelize, tableName: 'match_player_layouts', modelName: 'MatchPlayerLayout', timestamps: true }
);

export default MatchPlayerLayout;