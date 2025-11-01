import { QueryInterface, DataTypes } from 'sequelize';

export = {
  up: async (qi: QueryInterface) => {
    await qi.createTable('match_player_layouts', {
      matchId: { type: DataTypes.STRING, allowNull: false },
      userId:  { type: DataTypes.STRING, allowNull: false },
      team:    { type: DataTypes.ENUM('home','away'), allowNull: false },
      x:       { type: DataTypes.FLOAT, allowNull: false },
      y:       { type: DataTypes.FLOAT, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    });
    await qi.addConstraint('match_player_layouts', {
      fields: ['matchId','userId'],
      type: 'primary key',
      name: 'pk_match_player_layouts'
    });
    
  },
  down: async (qi: QueryInterface) => {
    await qi.dropTable('match_player_layouts');
  },
};