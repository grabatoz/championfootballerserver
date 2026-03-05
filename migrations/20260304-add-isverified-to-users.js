'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Add isVerified column - default true so existing users remain verified
    await queryInterface.addColumn('users', 'isVerified', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true, // existing users are treated as verified
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('users', 'isVerified');
  },
};
