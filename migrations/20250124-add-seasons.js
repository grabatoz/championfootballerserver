'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Create Seasons table
    await queryInterface.createTable('Seasons', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      leagueId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'Leagues',
          key: 'id'
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      seasonNumber: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        defaultValue: true,
      },
      startDate: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      endDate: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    // Add unique constraint on leagueId and seasonNumber
    await queryInterface.addIndex('Seasons', ['leagueId', 'seasonNumber'], {
      unique: true,
      name: 'seasons_league_season_number_unique'
    });

    // Add index for active season queries
    await queryInterface.addIndex('Seasons', ['leagueId', 'isActive'], {
      name: 'seasons_league_active_index'
    });

    // Create SeasonPlayers join table
    await queryInterface.createTable('SeasonPlayers', {
      seasonId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'Seasons',
          key: 'id'
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'Users',
          key: 'id'
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    // Add primary key constraint on SeasonPlayers
    await queryInterface.addConstraint('SeasonPlayers', {
      fields: ['seasonId', 'userId'],
      type: 'primary key',
      name: 'season_players_pkey'
    });

    // Add seasonId column to Matches table
    await queryInterface.addColumn('Matches', 'seasonId', {
      type: Sequelize.UUID,
      allowNull: true,
      references: {
        model: 'Seasons',
        key: 'id'
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    });

    // Add index for season matches
    await queryInterface.addIndex('Matches', ['seasonId'], {
      name: 'matches_season_id_index'
    });

    // Create Season 1 for all existing leagues
    const leagues = await queryInterface.sequelize.query(
      'SELECT id FROM "Leagues"',
      { type: Sequelize.QueryTypes.SELECT }
    );

    for (const league of leagues) {
      // Create Season 1 for this league
      await queryInterface.bulkInsert('Seasons', [{
        id: Sequelize.literal('uuid_generate_v4()'),
        leagueId: league.id,
        seasonNumber: 1,
        name: 'Season 1',
        isActive: true,
        startDate: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      }]);

      // Get the created season ID
      const [season] = await queryInterface.sequelize.query(
        `SELECT id FROM "Seasons" WHERE "leagueId" = :leagueId AND "seasonNumber" = 1`,
        {
          replacements: { leagueId: league.id },
          type: Sequelize.QueryTypes.SELECT
        }
      );

      if (season) {
        // Update all matches for this league to belong to Season 1
        await queryInterface.sequelize.query(
          `UPDATE "Matches" SET "seasonId" = :seasonId WHERE "leagueId" = :leagueId`,
          {
            replacements: { seasonId: season.id, leagueId: league.id }
          }
        );

        // Add all league members to Season 1
        const members = await queryInterface.sequelize.query(
          `SELECT "userId" FROM "LeagueMember" WHERE "leagueId" = :leagueId`,
          {
            replacements: { leagueId: league.id },
            type: Sequelize.QueryTypes.SELECT
          }
        );

        if (members.length > 0) {
          const seasonPlayers = members.map(member => ({
            seasonId: season.id,
            userId: member.userId,
            createdAt: new Date(),
            updatedAt: new Date()
          }));

          await queryInterface.bulkInsert('SeasonPlayers', seasonPlayers);
        }
      }
    }

    console.log('✅ Migration completed: Seasons created for all leagues');
  },

  down: async (queryInterface, Sequelize) => {
    // Remove seasonId from Matches
    await queryInterface.removeColumn('Matches', 'seasonId');

    // Drop SeasonPlayers table
    await queryInterface.dropTable('SeasonPlayers');

    // Drop Seasons table
    await queryInterface.dropTable('Seasons');

    console.log('✅ Migration rolled back: Seasons tables dropped');
  }
};
