var indexRouter = require('./routes/index');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var http = require("http");

const Game = require("./game");
const Utilities = require('./utilities');

var app = express();

require('dotenv').config({path: './auth.env'});
const {auth} = require('express-openid-connect');

// Auth0 authentication details
// const authConfig = {
//     required: false,
//     auth0Logout: true,
//     appSession: {
//       secret: process.env.AUTH_SECRET
//     },
//     baseURL: 'https://tickettoride.mawey.be',
//     clientID: '6536rh17o9VD1KkqEvz02Rz4vECMnwR5',
//     issuerBaseURL: 'https://dev-osfslp4f.eu.auth0.com'
// };
// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// app.use(auth(authConfig));
app.use(express.json());
app.use(express.urlencoded({extended: false}));
app.use(cookieParser());
app.use(express.static(__dirname + "/public"));

app.use('/', indexRouter);

var server = http.createServer(app);
const io = require('socket.io')(server);

let games = new Map();

function getUnusedGameCode() {
    let gid = `TTR${Math.floor(Math.random() * 10000)}`;
    if (games.has(gid)) {
        return getUnusedGameCode();
    } else {
        return gid;
    }
}

io.on('connection', (socket) => {

    socket.on('create-game', (options) => {
        if (!options.eu && !options.us) {
            socket.emit('something-went-wrong', "You should pick at least one continent!");
            return;
        }
        if (options.amount < 10 || options.amount > 99) {
            socket.emit('something-went-wrong', "You should set the amount of trains between 10 and 99!");
            return;
        }
        let gid = getUnusedGameCode();
		games.set(gid, new Game(gid, options.eu, options.us, options.amount));
        socket.emit('join', gid);
        console.log(`[CREATEGAME] Game with id ${gid} created!`);
    });

    socket.on('player-name', (data) => {
		let name = data.name;
		let gid = data.gid;
        let game = games.get(gid);
        // Check if the game exists
		if (game === undefined) {
		    socket.emit('invalid-game');
		    return;
		}
        // Add the player to the game
        let result = game.addPlayer(name, socket.id);
        if (result.status) {
            // Do the neccesary socket operations and communitcations
            socket.join(game.gameID);
            socket.emit('information', {playerID: result.id, gameID: game.gameID});
            io.in(game.gameID).emit('player-overview', game.getUserProperties());
        } else {
            // Send error to client
            socket.emit('something-went-wrong', result.message);
        }
    });

    socket.on('start-game', () => {
		let game = games.get(Object.keys(socket.rooms)[1]);
		if (game === undefined) {
	    	socket.emit('invalid-game');
	    	return;
		}
        // Ignore late or duplicate start signals once the game has moved on.
        if (game.gameState !== 'lobby') {
            return;
        }
        // Only the host (player 0, the first to join) can start the game.
        if (!game.player0 || game.player0.socketID !== socket.id) {
            socket.emit('something-went-wrong', 'Only the host can start the game!');
            return;
        }
        // Ticket to Ride requires at least 2 players.
        if (game.amountOfPlayers < 2) {
            socket.emit('something-went-wrong', 'You need at least 2 players to start!');
            return;
        }
        console.log('[STARTGAME] The game has been started by id ' + socket.id);
        game.gameState = 'routes';
        io.in(game.gameID).emit('start-game');
    });

    // FIXME Reloading on a single map game does not work
    socket.on('player-ingame-join', (info) =>  {
        let game = games.get(info.gameID);

        if (game === undefined) {
            socket.emit('lobby');
            return;
        }

        let pid = info.playerID;
        // Guard against stale or forged cookies. Without this, an unknown
        // pid would crash the server on the updatePlayerSocket call below
        // (calling .updatewebsocket on `undefined`).
        if (!Number.isInteger(pid) || pid < 0 || pid >= game.amountOfPlayers || game[`player${pid}`] == null) {
            socket.emit('lobby');
            return;
        }

        // Put the socket in the game room
        socket.join(info.gameID);

        // Send game options
        socket.emit('game-options', game.getOptions());

        // Send open cards
        socket.emit('open-cards', {cards: game.getOpenCards(), shuffle: false});

        // Send player info
        socket.emit('player-overview', game.getUserProperties());

        console.log("[UPGRADE] Player " + pid + " updated his socketID to " + socket.id);
        game.updatePlayerSocket(pid, socket.id);

        if (game.gameState === 'ongoing') {
            socket.emit('player-round', game.getPlayerRound());
            socket.emit('own-cards', game.getPlayerTrainCards(pid));
            socket.emit('own-destinations', game.getPlayerDestinations(pid));

            socket.emit('existing-trains', game.getExistingTrainImages());
        }

        if (game.gameState === 'routes') {
            game.createInitialTrianCardsForPlayer(pid);
            socket.emit('own-cards', game.getPlayerTrainCards(pid));

            let routes = game.getInitialDestinations(pid);
            socket.emit('initial-routes', routes);
        }
    });

    socket.on('request-scoring', (data) => {
        let game = games.get(data.gameID);
        if (game !== undefined) {
            if (game.endGameNow) {
                socket.emit('player-overview', game.getUserProperties());
                socket.emit('final-score', game.calculateScore());
                // The first time someone fetches the final score, schedule
                // the game to be evicted from the in-memory map so it stops
                // leaking. The 30-minute window gives every player time to
                // hit /score (and refresh) before we drop the data.
                if (!game.cleanupScheduled) {
                    game.cleanupScheduled = true;
                    setTimeout(() => {
                        console.log(`[CLEANUP] Removing finished game ${game.gameID}`);
                        games.delete(game.gameID);
                    }, 30 * 60 * 1000);
                }
            } else {
                socket.emit('play');
            }
        } else {
            socket.emit('lobby');
        }
    });

    socket.on('validate-first-destinations', (data) => {
        let game = games.get(Object.keys(socket.rooms)[1]);
        let result = game.validateFirstRoutesPicked(data);

        if (result.result) {
            socket.emit('validate-first-destinations', true);
        } else {
            socket.emit('invalidmove', {message: result.message});
        }
    });

    socket.on('accepted-destination', (data) => {
        let game = games.get(Object.keys(socket.rooms)[1]);
        let pid = data.pid;
        let routeID = data.rid.split("-");
        continent = routeID[0];
        destinationMap = continent + "Desti";

        if (game[destinationMap].get(routeID[1] + "-" + routeID[2]) !== undefined) {
            game["player" + pid].destinations.push(game[destinationMap].get(routeID[1] + "-" + routeID[2]));
        } else {
            game["player" + pid].destinations.push(game["long" + destinationMap].get(routeID[1] + "-" + routeID[2]));
        }

        game["player" + pid].numberOfRoutes++;

        let newlyCompleted = game.checkContinuity(pid);
        io.in(game.gameID).emit('player-overview', game.getUserProperties());

        // If the destination the player just accepted is already satisfied
        // by routes they own, mark it as completed in their hand right away.
        // Without this the ticket only flips to "completed" at end-of-game
        // scoring, which is confusing during play. See issue #87.
        if (game.gameState === "ongoing") {
            for (let desti of newlyCompleted) {
                socket.emit('player-completed-route', desti.continent + "-" + desti.stationA + "-" + desti.stationB);
            }
        }

        if (game.gameState === "routes") {
            console.log('[INFO] Player ' + pid + ' is now ready!')
            game["player" + pid].ready = true;

            if (game.allPlayersReady()) {
                game.currentRound = Math.ceil(Math.random() * game.amountOfPlayers) - 1;

                io.in(game.gameID).emit('player-round', game.getPlayerRound());

                game.mergeAllDestinations();
                console.log('[INFO] The game is now in the ongoing state.');
                game.gameState = 'ongoing';
            }
        }
    });

    socket.on('rejected-destination', (data) => {
        let game = games.get(Object.keys(socket.rooms)[1]);
        let routeID = data.split("-");
        continent = routeID[0];
        destinationMap = continent + "Desti";
        if (game[destinationMap].get(routeID[1] + "-" + routeID[2]) === undefined) {
            console.log("[INFO] A player rejected a long route");
            game[continent + "Stack"].push([routeID[1] + "-" + routeID[2], game["long" + destinationMap].get(routeID[1] + "-" + routeID[2])]);
            game.shuffleDestis();
        } else {
            console.log("[INFO] A player rejected a short route");
            game[continent + "Stack"].push([routeID[1] + "-" + routeID[2], game[destinationMap].get(routeID[1] + "-" + routeID[2])]);
            game.shuffleDestis();
        }
    });

    socket.on('open-train', (data) => {
        let game = games.get(Object.keys(socket.rooms)[1]);
        let pid = data.pid;
        console.log("[INFO] Player " + pid + " took an open train.");

        if (game.currentRound !== pid) {
            socket.emit('invalidmove', {message: 'It is currently not your turn!'});
            return;
        }

        if (game.routesLayed !== 0) {
            socket.emit('invalidmove', {message: 'You cannot pick cards after claiming a route!'});
            return;
        }

        if (game.thingsDone !== 0 && data.color === 'loco') {
            socket.emit('invalidmove', {message: 'You cannot pick a locomotive at the beginning of your turn!'});
            return;
        }

        let color = Utilities.getRandomColor();
        let oldColor = game.openCards[data.card];
        game.openCards[data.card] = color;

        io.in(game.gameID).emit('new-open-card', {repCard: data.card, newColor: color, pid: pid});

        if (game.checkNeedForShuffle()) {
            game.setOpenCards();
            io.in(game.gameID).emit('open-cards', {cards: game.getOpenCards(), shuffle: true});
        }

        game["player" + pid].takeTrain(data.color, true);

        if (oldColor === "loco") {
            game.nextPlayerRound();
        } else {
            game.playerDidSomething();
        }

        io.in(game.gameID).emit('player-overview', game.getUserProperties());
        socket.emit('own-cards', game["player" + pid].getTrainCards());
        if (game.checkGameEnd()) {
            game.sendStationsMessage(io);
            if (game.allPlayersReady()) {
                io.in(game.gameID).emit('game-end');
            };
        } else {
            io.in(game.gameID).emit('player-round', game.getPlayerRound());
        }
    });

    socket.on('closed-train', (pid) => {
        let game = games.get(Object.keys(socket.rooms)[1]);
        console.log("[INFO] Player " + pid + " requested a closed train.");

        if (game.currentRound !== pid) {
            socket.emit('invalidmove', {message: 'It is currently not your turn!'});
            return;
        }

        if (game.routesLayed !== 0) {
            socket.emit('invalidmove', {message: 'You cannot pick cards after claiming a route!'});
            return;
        }

        let color = Utilities.getRandomColor();

        socket.emit('closed-train', color);

        game["player" + pid].takeTrain(color, false);
        game.playerDidSomething();

        io.in(game.gameID).emit('player-overview', game.getUserProperties());
        socket.to(game.gameID).emit('closed-move', {pid: pid, move: "TRAIN-CARD"});
        socket.emit('own-cards', game["player" + pid].getTrainCards());

        if (game.checkGameEnd()) {
            game.sendStationsMessage(io);
            if (game.allPlayersReady()) {
                io.in(game.gameID).emit('game-end');
            };
        } else {
            io.in(game.gameID).emit('player-round', game.getPlayerRound());
        }
    });

    socket.on('route-claim', (data) => {
        let game = games.get(Object.keys(socket.rooms)[1]);
        console.log("[INFO] Player " + data.pid + " requested a route.");

        if (data.pid !== game.currentRound) {
            socket.emit('route-claim', {status: 'notYourTurn'});
            return;
        }

        if (game.routesLayed === 0 && game.thingsDone !== 0) {
            socket.emit('invalidmove', {message: 'You cannot claim a route after picking cards!'});
            return;
        }

        if (game.lastContinentRoutePut === data.continent) {
            socket.emit('route-claim', {status: 'alreadyClaimedThis', continent: data.continent});
            return;
        }

        let ret = game.checkEligibility(data.pid, data.color, data.route, data.continent);

        if (ret) {
            game.imagery.computeWagons(data.continent, data.route, game["player" + data.pid].color, io);

            game["player" + data.pid].routeIDs.push([data.continent, data.route]);

            io.in(game.gameID).emit('player-overview', game.getUserProperties());
            socket.emit('route-claim', {status: 'accepted', continent: data.continent});

            let routeMap = data.continent + "Routes";
            game.userClaimedRoute(data.pid, game[routeMap].get(data.route));

            game.playerPutRoute(data.continent);

            socket.emit('own-cards', game["player" + data.pid].getTrainCards());
            if (game.checkGameEnd()) {
                game.sendStationsMessage(io);
                if (game.allPlayersReady()) {
                    io.in(game.gameID).emit('game-end');
                };
            } else {
                io.in(game.gameID).emit('player-round', game.getPlayerRound());
            }
            for (let desti of game.checkContinuity(data.pid)) {
                socket.emit('player-completed-route', desti.continent + "-" + desti.stationA + "-" + desti.stationB);
            }
        } else {
            socket.emit('route-claim', {status: 'cant'});
        }
    });

    socket.on('station-claim', (data) => {
        let game = games.get(Object.keys(socket.rooms)[1]);
        console.log(`[INFO] Player ${data.pid} requested a station on ${data.city}`);

        if (game.currentRound !== data.pid) {
            socket.emit('invalidmove', {message: 'It is currently not your turn!'});
            return;
        }

        if (game.routesLayed === 0 && game.thingsDone !== 0) {
            socket.emit('invalidmove', {message: 'You cannot claim a station after picking cards!'});
            return;
        }

        let result = game.requestStation(data.pid, data.city, data.color);
        socket.emit('station-claim', result);

        if (result) {
            game.imagery.computeStations(data.continent, data.city, game[`player${data.pid}`].color, io);

            game.playerPutRoute('eu');
            socket.emit('own-cards', game["player" + data.pid].getTrainCards());
            io.in(game.gameID).emit('player-overview', game.getUserProperties());
            io.in(game.gameID).emit('player-round', game.getPlayerRound());
        }
    });

    socket.on('confirmed-stations', (data) => {
        let game = games.get(Object.keys(socket.rooms)[1]);
        game.userConfirmedStation(data.pid, data.routes);

        for (let desti of game.checkContinuity(data.pid)) {
            socket.emit('player-completed-route', desti.continent + "-" + desti.stationA + "-" + desti.stationB);
        }

        game[`player${data.pid}`].ready = true;

        if (game.allPlayersReady()) {
            io.in(game.gameID).emit('game-end');
        };
    });

    socket.on('player-destination', (pid) => {
        let game = games.get(Object.keys(socket.rooms)[1]);
        if (game.currentRound !== pid) {
            socket.emit('invalidmove', {message: 'It is currently not your turn!'});
            return;
        }

        if (game.thingsDone !== 0) {
            socket.emit('invalidmove', {message: 'You can only pick routes at the beginning of your turn!'});
            return;
        }
        socket.emit('player-destination', game.getDestination());
        socket.to(game.gameID).emit('closed-move', {pid: pid, move: "ROUTE-CARD"});
    });

    socket.on('player-finished', () => {
        let game = games.get(Object.keys(socket.rooms)[1]);
        if (game.gameState === "ongoing") {
            game.nextPlayerRound();
            if (game.checkGameEnd()) {
                game.sendStationsMessage(io);
                if (game.allPlayersReady()) {
                    io.in(game.gameID).emit('game-end');
                };
            } else {
                io.in(game.gameID).emit('player-round', game.getPlayerRound());
            }
        }
    });
});

let port = process.env.PORT || 8080;

console.info('Starting serever on port ' + port);
server.listen(port);
console.info('[SERVERSTART] Server started!');

module.exports = app;
