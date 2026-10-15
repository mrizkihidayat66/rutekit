import pkg from '../package.json';

/**
 * The build's version, read from the package manifest rather than repeated as a
 * literal: a string maintained in two places is a string that disagrees with
 * itself the first time only one of them is bumped.
 */
export const SERVER_VERSION: string = pkg.version;
