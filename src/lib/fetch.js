// https://gist.github.com/kiliankoe/928c3ddf851fb47aa62bdc950ca5bb56
// https://github.com/kiliankoe/vvo/wiki/WebAPI

import _ from 'lodash';
import {GK4toWGS84, parseMot, tryInt, vehicleOrder} from '@/lib/utils';
import store from '@/store';
import Logger, {errorToObject, stringifyObj} from '@/lib/logger';
import {FetchError, ValueError} from '@/lib/errors';

const logger = Logger.get('fetch');

function isApiResponseOk(res) {
    return [
        _.isPlainObject(res),
        res.ok,
        _.get(res, 'data.Status.Code', '').toLowerCase() === 'ok',
    ].every(entry => !!entry);
}

function parseApiDate(string) {
    if (!_.isString(string)) return string;

    // for departures on the same day: /Date(1513736087770+0100)/
    // departures on the next day: /Date(1513751520000-0000)/
    const match = string.match(/Date\((\d{1,13})[+-]\d{4}\)/);
    if (!match) throw new ValueError(`unable to parse Date in "${string}"`);

    return new Date(parseInt(match[1], 10));
}

async function fetchJson(options) {
    const defaults = {
        url: null,
        method: 'GET',
        username: null,
        password: null,
        data: null,
        type: 'application/json',
    };

    const opts = Object.assign({}, defaults, options);

    if (!opts.url) throw new ValueError('url required');

    const fetchArgs = {
        method: opts.method,
        headers: {},
    };

    if (opts.username && opts.password) {
        fetchArgs.headers.Authorization = `BASIC ${btoa(`${opts.username}:${opts.password}`)}`;
        fetchArgs.credentials = 'include';
    }

    if (opts.data) {
        fetchArgs.headers['Content-Type'] = `${opts.type}; charset=utf-8`;
        fetchArgs.body = _.isPlainObject(opts.data) ? JSON.stringify(opts.data) : opts.data;
    }

    logger.debug('fetch', Object.assign({}, opts, {password: '***'}));
    let response;
    try {
        response = await fetch(opts.url, fetchArgs);
    } catch (err) {
        logger.error('failed to fetch', {
            error: await errorToObject(err),
            options: Object.assign({}, opts, {password: '***'}),
            fetchArgs: Object.assign({}, fetchArgs, {headers: {Authorization: '***'}}),
            debug: {
                isVisible: store.state.isVisible,
                isOnline: store.state.isOnline,
            },
        });
        response = {};
    }

    let json = null;
    if (typeof response.json === 'function') {
        try {
            json = await response.json();
        } catch (err) {
            logger.error('failed to get JSON from response', {
                response,
                error: await errorToObject(err),
                options: Object.assign({}, opts, {password: '***'}),
                fetchArgs: Object.assign({}, fetchArgs, {headers: {Authorization: '***'}}),
            });
        }
    }
    logger.debug('fetched data', json);

    return {
        ok: response.status === 200,
        text: '',
        data: json,
        status: response.status,
    };
}

export async function fetchStations(query) {
    const res = await fetchJson({
        url: 'https://webapi.vvo-online.de/tr/pointfinder',
        method: 'POST',
        data: {
            query,
            stopsOnly: true,
            limit: 7,
            assignedStops: true,
            dvb: true,
        },
    });

    if (!isApiResponseOk(res) || !_.get(res, 'data.Points')) {
        const err = new FetchError(`fetch stations "${query}" caused unexpected response "${stringifyObj(res)}"`);
        if (!_.get(res, 'data')) {
            // no data
            err.code = 1;
        } else if (_.get(res, 'data.PointStatus') === 'NotIdentified') {
            // NotIdentified
            err.code = 2;
        } else {
            err.code = 255;
        }
        throw err;
    }

    const stations = res.data.Points
        .map(p => p.split('|'))
        .filter(p => p[3])
        // remove duplicates
        .filter((point, idx, arr) => idx === arr.findIndex(p => p[0] === point[0]))
        .map((p) => {
            const city = p[2] === '' ? 'Dresden' : p[2];
            return {
                city,
                stop: p[3],
                id: parseInt(p[0], 10),
                coords: GK4toWGS84(parseInt(p[4], 10), parseInt(p[5], 10)),
                timeFetched: Date.now(),
            };
        });

    logger.debug('fetched stations', stations);

    return stations;
}

type MediumOfTransportation = "Tram" | "CityBus" | "Cableway" | "Ferry" | "HailedSharedTaxi" | "IntercityBus" | "Train" | "SuburbanRailway"



export async function fetchDepartureV2(stationId, offset = 0, limit = 30, mediumOfTransportation: MediumOfTransportation[] | null = null) {
    const requestBody = {
        limit,
        stopid: String(stationId),
        isarrival: false,
        shorttermchanges: true,
        mentzonly: false,
    }

    if (offset) {
        const now = new Date();
        requestBody["time"] = new Date(now.getTime() + (offset * 60 * 1000)).toISOString()
    }

    if (mediumOfTransportation) {
        requestBody["mot"] = mediumOfTransportation
    }

    await fetch('https://webapi.vvo-online.de/dm', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(requestBody)
    });


}


export async function fetchDeparture(stationId, offset = 0, limit = 30) {
    if (store.getters.chosenMots.length === 0) return {};
    const now = new Date();
    const time = new Date(now.getTime() + (offset * 60 * 1000)).toISOString();
    const res = await fetchJson({
        url: 'https://webapi.vvo-online.de/dm',
        method: 'POST',
        data: {
            time,
            limit,
            stopid: String(stationId),
            isarrival: false,
            shorttermchanges: true,
            mentzonly: false,
            mot: store.getters.chosenMots,
        },
    });

    if (!isApiResponseOk(res)) {
        const err = new FetchError(`fetch departures for station "${stationId}" caused unexpected response "${stringifyObj(res)}"`);
        if (!_.get(res, 'data')) {
            // no data
            err.code = 1;
        } else if (
            _.get(res, 'data.Status.Code') === 'ServiceError' &&
            _.get(res, 'data.Status.Message') === 'no serving lines found'
        ) {
            // no serving lines
            err.code = 2;
        } else {
            err.code = 255;
        }
        throw err;
    }

    if (!res.data.Departures) res.data.Departures = [];

    const departures = {
        city: res.data.Place,
        stop: res.data.Name,
        status: res.data.Status,
        departures: res.data.Departures.map((d) => {
            const scheduledTime = parseApiDate(d.ScheduledTime);
            const arrivalTime = d.RealTime ? parseApiDate(d.RealTime) : scheduledTime;

            return {
                id: parseInt(d.Id, 10),
                arrivalTime,
                scheduledTime,
                line: d.LineName,
                direction: d.Direction,
                platform: d.Platform ?
                    {name: d.Platform.Name, type: d.Platform.Type} :
                    {},
                arrivalTimeRelative: Math.round((arrivalTime - now) / 1000 / 60),
                scheduledTimeRelative: Math.round((scheduledTime - now) / 1000 / 60),
                delayTime: Math.round((arrivalTime - scheduledTime) / 1000 / 60),
                state: d.State ? d.State : 'Unknown',
                mode: parseMot(d.Mot),
                diva: d.Diva ?
                    {number: parseInt(d.Diva.Number, 10), network: d.Diva.Network} :
                    {},
                routeChanges: d.RouteChanges ?
                    d.RouteChanges.map(x => parseInt(x, 10)) :
                    [],
            };
        }),
    };

    logger.debug('fetched departures', departures);

    return departures;
}

export async function fetchRouteChanges() {
    const res = await fetchJson({
        url: 'https://webapi.vvo-online.de/rc',
        method: 'POST',
        data: {shortterm: true},
    });

    if (!isApiResponseOk(res)) {
        throw new FetchError(`fetch route changes caused unexpected response "${stringifyObj(res)}"`);
    }

    const lines = res.data.Lines
        .filter(line => line.Mot)
        .reduce((indexedLines, line) => {
            const cleanLine = {
                id: parseInt(line.Id, 10),
                line: line.Name,
                mode: parseMot(line.Mot),
            };

            indexedLines[cleanLine.id] = cleanLine;

            return indexedLines;
        }, {});

    const routeChanges = res.data.Changes.reduce((indexedChanges, change) => {
        const sortedLines = change.LineIds
            .filter(line => line.mode)
            .map(line => lines[parseInt(line, 10)])
            .sort((a, b) => {
                const aVehIdx = vehicleOrder.indexOf(a.mode.name);
                const bVehIdx = vehicleOrder.indexOf(b.mode.name);
                if (aVehIdx < bVehIdx) return -1;
                if (aVehIdx > bVehIdx) return 1;

                const aLine = tryInt(a.line);
                const bLine = tryInt(b.line);
                if (typeof aLine === 'number' && typeof bLine === 'string') return -1;
                if (typeof aLine === 'string' && typeof bLine === 'number') return 1;
                if (tryInt(a.line) < tryInt(b.line)) return -1;
                if (tryInt(a.line) > tryInt(b.line)) return 1;

                return 0;
            });
        const linesByVehicle = _.groupBy(sortedLines, line => line.mode.name);
        const sortedByVehicle = vehicleOrder
            .reduce((acc, vehicle) => {
                if (vehicle in linesByVehicle) {
                    acc.push({vehicle, lines: linesByVehicle[vehicle]});
                }

                return acc;
            }, []);
        const cleanChange = {
            id: parseInt(change.Id, 10),
            lines: {
                all: sortedLines,
                sortedGroups: sortedByVehicle,
            },
            title: change.Title,
            description: change.Description,
            type: change.Type,
            published: parseApiDate(change.PublishDate),
            valid: change.ValidityPeriods ?
                change.ValidityPeriods.map(p => ({
                    begin: parseApiDate(p.Begin),
                    end: parseApiDate(p.End),
                })) :
                [],
        };

        indexedChanges[cleanChange.id] = cleanChange;

        return indexedChanges;
    }, {});

    logger.debug('fetched route changes', routeChanges);

    return routeChanges;
}

// for debugging in browser
if (process.env && process.env.NODE_ENV === 'development') {
    window.fetchJson = fetchJson;
    window.fetchStations = fetchStations;
    window.fetchDeparture = fetchDeparture;
    window.fetchRouteChanges = fetchRouteChanges;
}
