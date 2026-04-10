"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = createLogger;
const winston_1 = __importDefault(require("winston"));
function createLogger(config) {
    const formats = [
        winston_1.default.format.timestamp(),
        winston_1.default.format.errors({ stack: true }),
        winston_1.default.format.json()
    ];
    if (process.env.NODE_ENV === 'development') {
        formats.unshift(winston_1.default.format.colorize());
        formats.push(winston_1.default.format.simple());
    }
    const transports = [
        new winston_1.default.transports.Console({
            level: config.level,
            format: winston_1.default.format.combine(...formats)
        })
    ];
    if (config.file) {
        transports.push(new winston_1.default.transports.File({
            filename: config.file,
            level: config.level,
            format: winston_1.default.format.combine(...formats),
            maxsize: config.maxSize ? parseSize(config.maxSize) : 10485760,
            maxFiles: config.maxFiles || 5,
            tailable: true
        }));
    }
    return winston_1.default.createLogger({
        level: config.level,
        transports,
        exitOnError: false
    });
}
function parseSize(sizeStr) {
    const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(kb?|mb?|gb?)?$/i);
    if (!match) {
        throw new Error(`Invalid size format: ${sizeStr}`);
    }
    const size = parseFloat(match[1]);
    const unit = (match[2] || '').toLowerCase();
    switch (unit) {
        case 'k':
        case 'kb':
            return size * 1024;
        case 'm':
        case 'mb':
            return size * 1024 * 1024;
        case 'g':
        case 'gb':
            return size * 1024 * 1024 * 1024;
        default:
            return size;
    }
}
//# sourceMappingURL=logger.js.map