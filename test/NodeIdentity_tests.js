'use strict';

/**
 * Tests for NodeIdentity -- the human node name and the machine NodeKey generators.
 */

const Chai = require('chai');
const Expect = Chai.expect;

const libNodeIdentity = require('../source/NodeIdentity.js');

suite('NodeIdentity', () =>
{
	test('generateNodeName produces <Word>-<zero-padded ordinal>', () =>
	{
		let tmpName = libNodeIdentity.generateNodeName({ Ordinal: 1, Seed: 'somehost' });
		Expect(tmpName).to.match(/^[A-Z][a-z]+-001$/);
	});

	test('the word is stable for a given seed, the ordinal advances', () =>
	{
		let tmpOne = libNodeIdentity.generateNodeName({ Ordinal: 1, Seed: 'laptop-7' });
		let tmpTwo = libNodeIdentity.generateNodeName({ Ordinal: 2, Seed: 'laptop-7' });
		let tmpWordOne = tmpOne.split('-')[0];
		let tmpWordTwo = tmpTwo.split('-')[0];
		Expect(tmpWordOne).to.equal(tmpWordTwo);
		Expect(tmpTwo).to.equal(tmpWordOne + '-002');
	});

	test('the chosen word is one of the known words', () =>
	{
		let tmpWord = libNodeIdentity.pickWord('anything');
		Expect(libNodeIdentity.NAME_WORDS.indexOf(tmpWord)).to.be.at.least(0);
	});

	test('a missing/invalid ordinal defaults to 001', () =>
	{
		Expect(libNodeIdentity.generateNodeName({ Seed: 'h' }).endsWith('-001')).to.equal(true);
		Expect(libNodeIdentity.generateNodeName({ Ordinal: 0, Seed: 'h' }).endsWith('-001')).to.equal(true);
	});

	test('generateNodeKey is nk-<hostslug>-<hex> and unique per call', () =>
	{
		let tmpKeyOne = libNodeIdentity.generateNodeKey('My-Laptop.local');
		let tmpKeyTwo = libNodeIdentity.generateNodeKey('My-Laptop.local');
		Expect(tmpKeyOne).to.match(/^nk-my-laptop-[0-9a-f]{8}$/);
		Expect(tmpKeyOne).to.not.equal(tmpKeyTwo);
	});
});
