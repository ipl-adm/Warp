import trace from '#util/logging';
import Client from '#concepts/client';
import Entity, { SerializedEntity } from '#concepts/entity';
import { EntityConstructor, PlayerEntityConstructor } from '#concepts/entity';
import { System, Circle, Polygon } from 'detect-collisions';

import PlayerEntity from '#entities/entity_types/player';
import GameMap, { MapInfo } from '#concepts/map';
import { EventEmitter } from 'events';
import Lobby from '#concepts/lobby';
import RBush from 'rbush';
import chalk from 'chalk';
import PhysicsEntity from '#entities/physics_entity';

// export class MyRBush extends RBush<Entity> {
//     toBBox(e:Entity) { return e.bbox; }
//     compareMinX(a:Entity, b:Entity) { return a.bbox.left - b.bbox.left; }
//     compareMinY(a:Entity, b:Entity) { return a.bbox.top - b.bbox.top; }
// }


// import { entityNames } from '#entities/_entities';

export type RoomEvent = 'tick' | 'spawn' | 'player leave' | 'player join' | 'close';

export type SerializedRoom = {
    entities: SerializedEntity[],
    map: GameMap,
    player_count: number
};

export type RoomInfo = {
    map: MapInfo,
    player_count: number
}

const tickrate = global.config.tps || 60;

export class EntityList extends Array<Entity> {
    filterByType(type:string) {
        return this.filter(e => e.type === type);
    }

    ofType(type:string) {
        return this.filterByType(type);
    }

    // returns only the solid 
    solid() {
        return this.filter(e => e.isSolid);
    }

    withTag(tag:string) {
        return this.filter(e => e.hasTag(tag));
    }
}


interface Room {
    on(event:RoomEvent, callback:(...args:any[])=>void):this;
}

class Room extends EventEmitter {
    lobby:Lobby;
    tickrate:number = tickrate;
    entities:EntityList/*Entity[]*/ = new EntityList();
    tree:System;
    players:Client[] = [];
    recentlyJoined:Client[] = [];
    recentlyJoinedTimer = 120; // 2 seconds?

    width:number;
    height:number;

    map:GameMap;

    full_bundle:any[]; // all the entities packed
    bundle:any[]; // updated entities that need sending

    rest_timeout:number = 0; // disables processing entities when no players are present for config.room_rest_timeout seconds

    constructor(map:GameMap|string, lobby:Lobby) {
        super();
        this.lobby = lobby;

        // if provided a string -
        if (typeof map === 'string') {
            // find a map with the name
            this.map = global.maps.find(function(_map) {
                return _map.name === map;
            })

            if (this.map === undefined) {
                trace(`Error: could not find a map called "${map}"`);
                this.close();
                return;
            }
        }
        else { // otherwise - just set the map
            this.map = map;
        }

        this.width = this.map.width;
        this.height = this.map.height;
        
        // this.tree = new MyRBush(7);
        this.tree = new System();


        setInterval(this.tick.bind(this), 1000 / this.tickrate);
        this.unwrap(this.map.contents); // || '[]');
    }

    // create entities from the contents string
    unwrap(contents:string|SerializedEntity[] = '[]'):void {
        let entities:SerializedEntity[];
        if (typeof contents === 'string') {
            entities = JSON.parse(contents);
        }
        else if (Array.isArray(contents)) {
            entities = contents;
        }
        else {
            console.error('error unwrapping room contents - unknown type ' + typeof contents + " (string or array expected)");
            return;
        }

        entities.forEach(entity => {
            const etype = global.entityNames[entity.type];
            if (etype.type == 'Unknown') { // entity type doesn't exist
                trace(chalk.yellowBright('Warning: Entity of object type "' + entity.object_name + '" not found!'));
                return;
            }

            const e = this.spawnEntity(etype, entity.x, entity.y);
            e.xscale = entity.xscale;
            e.yscale = entity.yscale;

            e.regenerateCollider();
            for (let key in entity.props) {
                let value = entity.props[key];
                // warn about name collisions
                // if (e[key] !== undefined) {
                // if (key in Object.getOwnPropertyNames(PhysicsEntity)) {
                    // throw "Collision in props: entity of type " + e.type + " already has a variable called " + key + "!";
                // }
                if (!e.propNames.includes(key))
                    e.propNames.push(key);
                e[key] = value;
                // trace(key + ": " + value);
            }
        });
    }
    
    tick():void {
        let t_beforeTick = new Date().getTime(); // measure the tick time

        // don't process entities
        if (this.players.length === 0) {
            this.rest_timeout += 1 / this.tickrate;
            if (global.config.room.rest_timeout >= 0 // if this is enabled
                && this.rest_timeout > global.config.room.rest_timeout) {
                // do nothing - don't update the entities
                return;
            }
        }
        else { // reset the timer and wake up
            this.rest_timeout = 0;
        }

        this.bundle = []; // the updated ones
        this.full_bundle = []; // all the entities in the room

        this.entities.forEach(entity => {
            entity.update();
            this.full_bundle.push(entity.bundle());
        });
        this.emit('tick');

        // broadcast the min bundle (only changed entities)
        if (this.bundle.length > 0)
            this.broadcast({ cmd: 'entities', room: this.map.room_name, entities: this.bundle });

        let t_afterTick = new Date().getTime(); // measure the tick time in ms
        let t_tick = t_afterTick - t_beforeTick;

        // trace('tick:', t_tick);

        // we are lagging!
        if (global.config.verbose_lag && t_tick > (1000 / this.tickrate)) {
            trace(chalk.red('lag detected: this tick took ' + t_tick + ' milliseconds.'));
        }


        // we will send everything every frame to those who joined recently (so that they 100% get it)
        this.recentlyJoined.forEach((player) => {
            player.send({ cmd: 'entities', room: this.map.room_name, entities: this.full_bundle });
        });
        this.recentlyJoined = [];
    }

    // entity stuff
    spawnEntity(etype:PlayerEntityConstructor, x:number, y:number, client?:Client): PlayerEntity;
    spawnEntity(etype:EntityConstructor, x:number, y:number, client?:Client): Entity {
        if (!global.config.entities_enabled) {
            console.error("Warning: Spawning entities is disabled globally! Room.spawnEntity() returning null. You can change this in config.js/ts");
            return null;
        }


        if (client === null) {
            var entity = new etype(this, x, y);
        }
        else {
            var entity = new (etype as PlayerEntityConstructor)(this, x, y, client);
        }

        entity.create();
        this.entities.push(entity);

        entity.on('death', () => {
            this.broadcast({ cmd: 'entity death', id: entity.uuid });
        });

        entity.on('remove', () => {
            this.broadcast({ cmd: 'entity remove', id: entity.uuid });
        });

        this.emit('spawn', entity);

        return entity;
    }

    // player manipulation
    removePlayer(player:Client):void {
        // remove from this.players
        let idx = this.players.indexOf(player);
        if (idx !== -1)
            this.players.splice(idx, 1);
        
        // remove from this.recentlyJoined
        idx = this.recentlyJoined.indexOf(player);
        if (idx !== -1)
            this.recentlyJoined.splice(idx, 1);
        
        
        player.room = null;
        if (player.entity !== null) {
            player.entity.remove();
            player.entity = null;
        }
        this.emit('player leave', player);
        // this.broadcast({ cmd: 'player leave', player: player });
    }

    addPlayer(player:Client):void {
        this.players.push(player);
        player.room = this;
        
        let x:number, y:number;

        // load the position from the db - uncomment if you want persistent position
        // if (player.profile) {
        //     x = player.profile.x;
        //     y = player.profile.y;
        // }
        // else {

        // }

        if (global.config.entities_enabled) {
            const p = this.map.getStartPos(this.players.length-1);
            x = p.x;
            y = p.y;
            const player_entity = this.spawnEntity(PlayerEntity, x, y, player);
            player.entity = player_entity;
        }
        // add to the recently joined list to receive the old entities
        this.recentlyJoined.push(player);
        
        this.emit('player join', player);
    }

    // move between rooms
    movePlayer(player:Client, new_room:Room):void {
        this.removePlayer(player);
        new_room.addPlayer(player);

        player.sendRoomTransition(new_room, player.entity.pos, player.entity.uuid);
    }

    broadcast(packet:object) {
        this.players.forEach(player => {
            player.write(packet);
        })
    }

    close():void {
        this.emit('close');
        this.broadcast({cmd: 'room kick', message: 'Room is closing'});
        while(this.players.length > 0) {
            this.removePlayer(this.players[0]);
        }
    }

    serialize():SerializedRoom {
        return {
            player_count: this.players.length,
            map: this.map,
            entities: this.entities.map(e => e.serialize())
        };
    }

    getInfo():RoomInfo {
        return {
            player_count: this.players.length,
            map: this.map.getInfo()
        }
    }
}



export default Room;