'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'provider', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    
    await queryInterface.addColumn('users', 'providerId', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('users', 'provider');
    await queryInterface.removeColumn('users', 'providerId');
  }
};