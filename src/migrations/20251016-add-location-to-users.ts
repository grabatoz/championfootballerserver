import { QueryInterface, DataTypes } from 'sequelize';

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.addColumn('users', 'country', {
      type: DataTypes.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('users', 'state', {
      type: DataTypes.STRING,
      allowNull: true,
    });
    await queryInterface.addColumn('users', 'city', {
      type: DataTypes.STRING,
      allowNull: true,
    });
  },

  
  down: async (queryInterface: QueryInterface) => {
    await queryInterface.removeColumn('users', 'country');
    await queryInterface.removeColumn('users', 'state');
    await queryInterface.removeColumn('users', 'city');
  }
};
