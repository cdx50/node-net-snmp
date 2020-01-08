
// Copyright 2013 Stephen Vickers <stephen.vickers.sv@gmail.com>

var ber = require ("asn1-ber").Ber;
var dgram = require ("dgram");
var events = require ("events");
var util = require ("util");
var crypto = require("crypto");

/*****************************************************************************
 ** Constants
 **/

function _expandConstantObject (object) {
	var keys = [];
	for (var key in object)
		keys.push (key);
	for (var i = 0; i < keys.length; i++)
		object[object[keys[i]]] = parseInt (keys[i]);
}

var ErrorStatus = {
	0: "NoError",
	1: "TooBig",
	2: "NoSuchName",
	3: "BadValue",
	4: "ReadOnly",
	5: "GeneralError",
	6: "NoAccess",
	7: "WrongType",
	8: "WrongLength",
	9: "WrongEncoding",
	10: "WrongValue",
	11: "NoCreation",
	12: "InconsistentValue",
	13: "ResourceUnavailable",
	14: "CommitFailed",
	15: "UndoFailed",
	16: "AuthorizationError",
	17: "NotWritable",
	18: "InconsistentName"
};

_expandConstantObject (ErrorStatus);

var ObjectType = {
	1: "Boolean",
	2: "Integer",
	4: "OctetString",
	5: "Null",
	6: "OID",
	64: "IpAddress",
	65: "Counter",
	66: "Gauge",
	67: "TimeTicks",
	68: "Opaque",
	70: "Counter64",
	128: "NoSuchObject",
	129: "NoSuchInstance",
	130: "EndOfMibView"
};

_expandConstantObject (ObjectType);

ObjectType.Integer32 = ObjectType.Integer;
ObjectType.Counter32 = ObjectType.Counter;
ObjectType.Gauge32 = ObjectType.Gauge;
ObjectType.Unsigned32 = ObjectType.Gauge32;

var PduType = {
	160: "GetRequest",
	161: "GetNextRequest",
	162: "GetResponse",
	163: "SetRequest",
	164: "Trap",
	165: "GetBulkRequest",
	166: "InformRequest",
	167: "TrapV2",
	168: "Report"
};

_expandConstantObject (PduType);

var TrapType = {
	0: "ColdStart",
	1: "WarmStart",
	2: "LinkDown",
	3: "LinkUp",
	4: "AuthenticationFailure",
	5: "EgpNeighborLoss",
	6: "EnterpriseSpecific"
};

_expandConstantObject (TrapType);

var UsmLevel = {
	1: "noAuthNoPriv",
	2: "authNoPriv",
	3: "authPriv"
};

_expandConstantObject (UsmLevel);

var UsmAuthProtocol = {
	0: "md5"
};

_expandConstantObject (UsmAuthProtocol);

var UsmPrivProtocol = {
	0: "DES"
};

_expandConstantObject (UsmPrivProtocol);

var Version1 = 0;
var Version2c = 1;
var Version3 = 3;

var Version = {
	"1": Version1,
	"2c": Version2c,
	"3": Version3
};

/*****************************************************************************
 ** Exception class definitions
 **/

function ResponseInvalidError (message) {
	this.name = "ResponseInvalidError";
	this.message = message;
	Error.captureStackTrace(this, ResponseInvalidError);
}
util.inherits (ResponseInvalidError, Error);

function RequestInvalidError (message) {
	this.name = "RequestInvalidError";
	this.message = message;
	Error.captureStackTrace(this, RequestInvalidError);
}
util.inherits (RequestInvalidError, Error);

function RequestFailedError (message, status) {
	this.name = "RequestFailedError";
	this.message = message;
	this.status = status;
	Error.captureStackTrace(this, RequestFailedError);
}
util.inherits (RequestFailedError, Error);

function RequestTimedOutError (message) {
	this.name = "RequestTimedOutError";
	this.message = message;
	Error.captureStackTrace(this, RequestTimedOutError);
}
util.inherits (RequestTimedOutError, Error);

/*****************************************************************************
 ** OID and varbind helper functions
 **/

function isVarbindError (varbind) {
	return !!(varbind.type == ObjectType.NoSuchObject
	|| varbind.type == ObjectType.NoSuchInstance
	|| varbind.type == ObjectType.EndOfMibView);
}

function varbindError (varbind) {
	return (ObjectType[varbind.type] || "NotAnError") + ": " + varbind.oid;
}

function oidFollowsOid (oidString, nextString) {
	var oid = {str: oidString, len: oidString.length, idx: 0};
	var next = {str: nextString, len: nextString.length, idx: 0};
	var dotCharCode = ".".charCodeAt (0);

	function getNumber (item) {
		var n = 0;
		if (item.idx >= item.len)
			return null;
		while (item.idx < item.len) {
			var charCode = item.str.charCodeAt (item.idx++);
			if (charCode == dotCharCode)
				return n;
			n = (n ? (n * 10) : n) + (charCode - 48);
		}
		return n;
	}

	while (1) {
		var oidNumber = getNumber (oid);
		var nextNumber = getNumber (next);

		if (oidNumber !== null) {
			if (nextNumber !== null) {
				if (nextNumber > oidNumber) {
					return true;
				} else if (nextNumber < oidNumber) {
					return false;
				}
			} else {
				return true;
			}
		} else {
			return true;
		}
	}
}

function oidInSubtree (oidString, nextString) {
	var oid = oidString.split (".");
	var next = nextString.split (".");

	if (oid.length > next.length)
		return false;

	for (var i = 0; i < oid.length; i++) {
		if (next[i] != oid[i])
			return false;
	}

	return true;
}

/**
 ** Some SNMP agents produce integers on the wire such as 00 ff ff ff ff.
 ** The ASN.1 BER parser we use throws an error when parsing this, which we
 ** believe is correct.  So, we decided not to bother the "asn1" developer(s)
 ** with this, instead opting to work around it here.
 **
 ** If an integer is 5 bytes in length we check if the first byte is 0, and if so
 ** simply drop it and parse it like it was a 4 byte integer, otherwise throw
 ** an error since the integer is too large.
 **/

function readInt (buffer) {
	return readUint (buffer, true);
}

function readUint (buffer, isSigned) {
	buffer.readByte ();
	var length = buffer.readByte ();
	var value = 0;
	var signedBitSet = false;

	if (length > 5) {
		 throw new RangeError ("Integer too long '" + length + "'");
	} else if (length == 5) {
		if (buffer.readByte () !== 0)
			throw new RangeError ("Integer too long '" + length + "'");
		length = 4;
	}

	for (var i = 0; i < length; i++) {
		value *= 256;
		value += buffer.readByte ();

		if (isSigned && i <= 0) {
			if ((value & 0x80) == 0x80)
				signedBitSet = true;
		}
	}
	
	if (signedBitSet)
		value -= (1 << (i * 8));

	return value;
}

function readUint64 (buffer) {
	var value = buffer.readString (ObjectType.Counter64, true);

	return value;
}

function readVarbinds (buffer, varbinds) {
	buffer.readSequence ();

	while (1) {
		buffer.readSequence ();
		var oid = buffer.readOID ();
		var type = buffer.peek ();

		if (type == null)
			break;

		var value;

		if (type == ObjectType.Boolean) {
			value = buffer.readBoolean ();
		} else if (type == ObjectType.Integer) {
			value = readInt (buffer);
		} else if (type == ObjectType.OctetString) {
			value = buffer.readString (null, true);
		} else if (type == ObjectType.Null) {
			buffer.readByte ();
			buffer.readByte ();
			value = null;
		} else if (type == ObjectType.OID) {
			value = buffer.readOID ();
		} else if (type == ObjectType.IpAddress) {
			var bytes = buffer.readString (ObjectType.IpAddress, true);
			if (bytes.length != 4)
				throw new ResponseInvalidError ("Length '" + bytes.length
						+ "' of IP address '" + bytes.toString ("hex")
						+ "' is not 4");
			value = bytes[0] + "." + bytes[1] + "." + bytes[2] + "." + bytes[3];
		} else if (type == ObjectType.Counter) {
			value = readUint (buffer);
		} else if (type == ObjectType.Gauge) {
			value = readUint (buffer);
		} else if (type == ObjectType.TimeTicks) {
			value = readUint (buffer);
		} else if (type == ObjectType.Opaque) {
			value = buffer.readString (ObjectType.Opaque, true);
		} else if (type == ObjectType.Counter64) {
			value = readUint64 (buffer);
		} else if (type == ObjectType.NoSuchObject) {
			buffer.readByte ();
			buffer.readByte ();
			value = null;
		} else if (type == ObjectType.NoSuchInstance) {
			buffer.readByte ();
			buffer.readByte ();
			value = null;
		} else if (type == ObjectType.EndOfMibView) {
			buffer.readByte ();
			buffer.readByte ();
			value = null;
		} else {
			throw new ResponseInvalidError ("Unknown type '" + type
					+ "' in response");
		}

		varbinds.push ({
			oid: oid,
			type: type,
			value: value
		});
	}
}

function writeUint (buffer, type, value) {
	var b = Buffer.alloc (4);
	b.writeUInt32BE (value, 0);
	buffer.writeBuffer (b, type);
}

function writeUint64 (buffer, value) {
	buffer.writeBuffer (value, ObjectType.Counter64);
}

function writeVarbinds (buffer, varbinds) {
	buffer.startSequence ();
	for (var i = 0; i < varbinds.length; i++) {
		buffer.startSequence ();
		buffer.writeOID (varbinds[i].oid);

		if (varbinds[i].type && varbinds[i].hasOwnProperty("value")) {
			var type = varbinds[i].type;
			var value = varbinds[i].value;

			if (type == ObjectType.Boolean) {
				buffer.writeBoolean (value ? true : false);
			} else if (type == ObjectType.Integer) { // also Integer32
				buffer.writeInt (value);
			} else if (type == ObjectType.OctetString) {
				if (typeof value == "string")
					buffer.writeString (value);
				else
					buffer.writeBuffer (value, ObjectType.OctetString);
			} else if (type == ObjectType.Null) {
				buffer.writeNull ();
			} else if (type == ObjectType.OID) {
				buffer.writeOID (value);
			} else if (type == ObjectType.IpAddress) {
				var bytes = value.split (".");
				if (bytes.length != 4)
					throw new RequestInvalidError ("Invalid IP address '"
							+ value + "'");
				buffer.writeBuffer (Buffer.from (bytes), 64);
			} else if (type == ObjectType.Counter) { // also Counter32
				writeUint (buffer, ObjectType.Counter, value);
			} else if (type == ObjectType.Gauge) { // also Gauge32 & Unsigned32
				writeUint (buffer, ObjectType.Gauge, value);
			} else if (type == ObjectType.TimeTicks) {
				writeUint (buffer, ObjectType.TimeTicks, value);
			} else if (type == ObjectType.Opaque) {
				buffer.writeBuffer (value, ObjectType.Opaque);
			} else if (type == ObjectType.Counter64) {
				writeUint64 (buffer, value);
			} else {
				throw new RequestInvalidError ("Unknown type '" + type
						+ "' in request");
			}
		} else {
			buffer.writeNull ();
		}

		buffer.endSequence ();
	}
	buffer.endSequence ();
}

/*****************************************************************************
 ** PDU class definitions
 **/

var SimplePdu = function (id, varbinds, options) {
	this.id = id;
	this.varbinds = varbinds;
	this.options = options || {};
};

SimplePdu.prototype.toBuffer = function (buffer) {
	buffer.startSequence (this.type);

	buffer.writeInt (this.id);
	buffer.writeInt ((this.type == PduType.GetBulkRequest)
			? (this.options.nonRepeaters || 0)
			: 0);
	buffer.writeInt ((this.type == PduType.GetBulkRequest)
			? (this.options.maxRepetitions || 0)
			: 0);

	writeVarbinds (buffer, this.varbinds);

	buffer.endSequence ();
};

var GetBulkRequestPdu = function () {
	this.type = PduType.GetBulkRequest;
	GetBulkRequestPdu.super_.apply (this, arguments);
};

util.inherits (GetBulkRequestPdu, SimplePdu);

var GetNextRequestPdu = function () {
	this.type = PduType.GetNextRequest;
	GetNextRequestPdu.super_.apply (this, arguments);
};

util.inherits (GetNextRequestPdu, SimplePdu);

var GetRequestPdu = function () {
	this.type = PduType.GetRequest;
	GetRequestPdu.super_.apply (this, arguments);
};

util.inherits (GetRequestPdu, SimplePdu);

var InformRequestPdu = function () {
	this.type = PduType.InformRequest;
	InformRequestPdu.super_.apply (this, arguments);
};

util.inherits (InformRequestPdu, SimplePdu);

var SetRequestPdu = function () {
	this.type = PduType.SetRequest;
	SetRequestPdu.super_.apply (this, arguments);
};

util.inherits (SetRequestPdu, SimplePdu);

var TrapPdu = function (typeOrOid, varbinds, options) {
	this.type = PduType.Trap;

	this.agentAddr = options.agentAddr || "127.0.0.1";
	this.upTime = options.upTime;

	if (typeof typeOrOid == "string") {
		this.generic = TrapType.EnterpriseSpecific;
		this.specific = parseInt (typeOrOid.match (/\.(\d+)$/)[1]);
		this.enterprise = typeOrOid.replace (/\.(\d+)$/, "");
	} else {
		this.generic = typeOrOid;
		this.specific = 0;
		this.enterprise = "1.3.6.1.4.1";
	}

	this.varbinds = varbinds;
};

TrapPdu.prototype.toBuffer = function (buffer) {
	buffer.startSequence (this.type);

	buffer.writeOID (this.enterprise);
	buffer.writeBuffer (Buffer.from (this.agentAddr.split (".")),
			ObjectType.IpAddress);
	buffer.writeInt (this.generic);
	buffer.writeInt (this.specific);
	writeUint (buffer, ObjectType.TimeTicks,
			this.upTime || Math.floor (process.uptime () * 100));

	writeVarbinds (buffer, this.varbinds);

	buffer.endSequence ();
};

var TrapV2Pdu = function () {
	this.type = PduType.TrapV2;
	TrapV2Pdu.super_.apply (this, arguments);
};

util.inherits (TrapV2Pdu, SimplePdu);

var GetResponsePdu = function (reader) {
	//this.type = PduType.GetResponse;
	this.type = reader.peek ();

	reader.readSequence (this.type);

	this.id = reader.readInt ();

	this.errorStatus = reader.readInt ();
	this.errorIndex = reader.readInt ();

	this.varbinds = [];

	readVarbinds (reader, this.varbinds);
};

// we never create Report PDUs - so not needed at present
// var ReportPdu = function () {
// 	this.type = PduType.ReportPdu;
// 	ReportPdu.super_.apply (this, arguments);
// };

var readPdu = function (reader, scoped) {
	var pdu;
	if ( scoped ) {
		reader.readSequence ();
		contextEngineID = reader.readString (ber.OctetString, true);
		contextName = reader.readString ();
	}
	var type = reader.peek ();

	if (type == PduType.GetResponse) {
		pdu = new GetResponsePdu (reader);
	} else if (type == PduType.Report ) {
		pdu = new GetResponsePdu (reader);
	} else {
		throw new ResponseInvalidError ("Unknown PDU type '" + type
				+ "' in response");
	}
	return pdu;
};

var createDiscoveryPdu = function (target, host) {
	return new GetRequestPdu(_generateId(), [], {});
};

var Authentication = {};

Authentication.HMAC_BUFFER_SIZE = 1024*1024;
Authentication.HMAC_BLOCK_SIZE = 64;
Authentication.AUTHENTICATION_CODE_LENGTH = 12;
Authentication.AUTH_PARAMETERS_PLACEHOLDER = Buffer.from('8182838485868788898a8b8c', 'hex');

Authentication.algorithms = {
	md5: {
		// KEY_LENGTH: 16,
		CRYPTO_ALGORITHM: 'md5'
	},
	sha: {
		// KEY_LENGTH: 20,
		CRYPTO_ALGORITHM: 'sha1'
	}
}

// Adapted from RFC3414 Appendix A.2.1. Password to Key Sample Code for MD5
Authentication.passwordToKey = function (authProtocol, authPasswordString, engineID) {
	var hashAlgorithm;
	var firstDigest;
	var finalDigest;
	var buf = Buffer.alloc (Authentication.HMAC_BUFFER_SIZE);
	var bufOffset = 0;
	var passwordIndex = 0;
	var count = 0;
	var password = Buffer.from (authPasswordString);
	var cryptoAlgorithm = Authentication.algorithms[authProtocol].CRYPTO_ALGORITHM;
	
	while (count < Authentication.HMAC_BUFFER_SIZE) {
		for (var i = 0; i < Authentication.HMAC_BLOCK_SIZE; i++) {
			buf.writeUInt8(password[passwordIndex++ % password.length], bufOffset++);
		}
		count += Authentication.HMAC_BLOCK_SIZE;
	}
	hashAlgorithm = crypto.createHash(cryptoAlgorithm);
	hashAlgorithm.update(buf);
	firstDigest = hashAlgorithm.digest();
	// console.log("First digest:  " + firstDigest.toString('hex'));

	hashAlgorithm = crypto.createHash(cryptoAlgorithm);
	hashAlgorithm.update(firstDigest);
	hashAlgorithm.update(engineID);
	hashAlgorithm.update(firstDigest);
	finalDigest = hashAlgorithm.digest();
	// console.log("Localized key: " + finalDigest.toString('hex'));

	return finalDigest;
};

Authentication.addParametersToMessageBuffer = function (messageBuffer, authProtocol, authPassword, engineID) {
	var authenticationParametersOffset;
	var digestToAdd;

	// clear the authenticationParameters field in message
	authenticationParametersOffset = messageBuffer.indexOf (Authentication.AUTH_PARAMETERS_PLACEHOLDER);
	messageBuffer.fill (0, authenticationParametersOffset, authenticationParametersOffset + Authentication.AUTHENTICATION_CODE_LENGTH);

	digestToAdd = Authentication.calculateDigest (messageBuffer, authProtocol, authPassword, engineID);
	digestToAdd.copy (messageBuffer, authenticationParametersOffset, 0, Authentication.AUTHENTICATION_CODE_LENGTH);
	//console.log("Added Auth Parameters: " + digestToAdd.toString('hex'));
};

Authentication.isAuthentic = function (messageBuffer, authProtocol, authPassword, engineID, digestInMessage) {
	var authenticationParametersOffset;
	var calculatedDigest;

	// clear the authenticationParameters field in message
	authenticationParametersOffset = messageBuffer.indexOf (digestInMessage);
	messageBuffer.fill (0, authenticationParametersOffset, authenticationParametersOffset + Authentication.AUTHENTICATION_CODE_LENGTH);

	calculatedDigest = Authentication.calculateDigest (messageBuffer, authProtocol, authPassword, engineID);

	// replace previously cleared authenticationParameters field in message
	digestInMessage.copy (messageBuffer, authenticationParametersOffset, 0, Authentication.AUTHENTICATION_CODE_LENGTH);

	// console.log ("Digest in message: " + digestInMessage.toString('hex'));
	// console.log ("Calculated digest: " + calculatedDigest.toString('hex'));
	return calculatedDigest.equals (digestInMessage, Authentication.AUTHENTICATION_CODE_LENGTH);
};

Authentication.calculateDigest = function (messageBuffer, authProtocol, authPassword, engineID) {
	var authKey = Authentication.passwordToKey (authProtocol, authPassword, engineID);

	// Adapted from RFC3147 Section 6.3.1. Processing an Outgoing Message
	var hashAlgorithm;
	var kIpad;
	var kOpad;
	var firstDigest;
	var finalDigest;
	var truncatedDigest;
	var i;
	var cryptoAlgorithm = Authentication.algorithms[authProtocol].CRYPTO_ALGORITHM;

	if (authKey.length > Authentication.HMAC_BLOCK_SIZE) {
		hashAlgorithm = crypto.createHash (cryptoAlgorithm);
		hashAlgorithm.update (authKey);
		authKey = hashAlgorithm.digest ();
	}

	// MD(K XOR opad, MD(K XOR ipad, msg))
	kIpad = Buffer.alloc (Authentication.HMAC_BLOCK_SIZE);
	kOpad = Buffer.alloc (Authentication.HMAC_BLOCK_SIZE);
	for (i = 0; i < authKey.length; i++) {
		kIpad[i] = authKey[i] ^ 0x36;
		kOpad[i] = authKey[i] ^ 0x5c;
	}
	kIpad.fill (0x36, authKey.length);
	kOpad.fill (0x5c, authKey.length);

	// inner MD
	hashAlgorithm = crypto.createHash (cryptoAlgorithm);
	hashAlgorithm.update (kIpad);
	hashAlgorithm.update (messageBuffer);
	firstDigest = hashAlgorithm.digest ();
	// outer MD
	hashAlgorithm = crypto.createHash (cryptoAlgorithm);
	hashAlgorithm.update (kOpad);
	hashAlgorithm.update (firstDigest);
	finalDigest = hashAlgorithm.digest ();

	truncatedDigest = Buffer.alloc (Authentication.AUTHENTICATION_CODE_LENGTH);
	finalDigest.copy (truncatedDigest, 0, 0, Authentication.AUTHENTICATION_CODE_LENGTH);
	return truncatedDigest;
};

var Encryption = {};

Encryption.INPUT_KEY_LENGTH = 16;
Encryption.DES_KEY_LENGTH = 8;
Encryption.DES_BLOCK_LENGTH = 8;
Encryption.CRYPTO_DES_ALGORITHM = 'des-cbc';
Encryption.PRIV_PARAMETERS_PLACEHOLDER = Buffer.from ('9192939495969798', 'hex');

Encryption.encryptPdu = function (scopedPdu, privProtocol, privPassword, authProtocol, engineID) {
	var privLocalizedKey;
	var encryptionKey;
	var preIv;
	var salt;
	var iv;
	var i;
	var paddedScopedPduLength;
	var paddedScopedPdu;
	var encryptedPdu;
	var cbcProtocol = Encryption.CRYPTO_DES_ALGORITHM;

	privLocalizedKey = Authentication.passwordToKey (authProtocol, privPassword, engineID);
	encryptionKey = Buffer.alloc (Encryption.DES_KEY_LENGTH);
	privLocalizedKey.copy (encryptionKey, 0, 0, Encryption.DES_KEY_LENGTH);
	preIv = Buffer.alloc (Encryption.DES_BLOCK_LENGTH);
	privLocalizedKey.copy (preIv, 0, Encryption.DES_KEY_LENGTH, Encryption.DES_KEY_LENGTH + Encryption.DES_BLOCK_LENGTH);

	salt = Buffer.alloc (Encryption.DES_BLOCK_LENGTH);
	// set local SNMP engine boots part of salt to 1, as we have no persistent engine state
	salt.fill ('00000001', 0, 4, 'hex');
	// set local integer part of salt to random
	salt.fill (crypto.randomBytes (4), 4, 8);
	iv = Buffer.alloc (Encryption.DES_BLOCK_LENGTH);
	for (i = 0; i < iv.length; i++) {
		iv[i] = preIv[i] ^ salt[i];
	}
	
	if (scopedPdu.length % Encryption.DES_BLOCK_LENGTH == 0) {
		paddedScopedPdu = scopedPdu;
	} else {
		paddedScopedPduLength = Encryption.DES_BLOCK_LENGTH * (Math.floor (scopedPdu.length / Encryption.DES_BLOCK_LENGTH) + 1);
		paddedScopedPdu = Buffer.alloc (paddedScopedPduLength);
		scopedPdu.copy (paddedScopedPdu, 0, 0, scopedPdu.length);
	}
	cipher = crypto.createCipheriv (cbcProtocol, encryptionKey, iv);
	encryptedPdu = cipher.update (paddedScopedPdu);
	encryptedPdu = Buffer.concat ([encryptedPdu, cipher.final()]);
	// console.log ("Key: " + encryptionKey.toString ('hex'));
	// console.log ("IV:  " + iv.toString ('hex'));
	// console.log ("Plain:     " + paddedScopedPdu.toString ('hex'));
	// console.log ("Encrypted: " + encryptedPdu.toString ('hex'));

	return {
		encryptedPdu: encryptedPdu,
		msgPrivacyParameters: salt
	};
};

Encryption.decryptPdu = function (encryptedPdu, privProtocol, privParameters, privPassword, authProtocol, engineID) {
	var privLocalizedKey;
	var decryptionKey;
	var preIv;
	var salt;
	var iv;
	var i;
	var decryptedPdu;
	var cbcProtocol = privProtocol + '-cbc';

	privLocalizedKey = Authentication.passwordToKey (authProtocol, privPassword, engineID);
	decryptionKey = Buffer.alloc (Encryption.DES_KEY_LENGTH);
	privLocalizedKey.copy (decryptionKey, 0, 0, Encryption.DES_KEY_LENGTH);
	preIv = Buffer.alloc (Encryption.DES_BLOCK_LENGTH);
	privLocalizedKey.copy (preIv, 0, Encryption.DES_KEY_LENGTH, Encryption.DES_KEY_LENGTH + Encryption.DES_BLOCK_LENGTH);

	salt = privParameters;
	iv = Buffer.alloc (Encryption.DES_BLOCK_LENGTH);
	for (i = 0; i < iv.length; i++) {
		iv[i] = preIv[i] ^ salt[i];
	}
	
	decipher = crypto.createDecipheriv (cbcProtocol, decryptionKey, iv);
	decryptedPdu = decipher.update (encryptedPdu);
	decryptedPdu = Buffer.concat ([decryptedPdu, decipher.final()]);
	// console.log ("Key: " + decryptionKey.toString ('hex'));
	// console.log ("IV:  " + iv.toString ('hex'));
	// console.log ("Encrypted: " + encryptedPdu.toString ('hex'));
	// console.log ("Plain:     " + decryptedPdu.toString ('hex'));

	return decryptedPdu;

};

Encryption.addParametersToMessageBuffer = function (messageBuffer, msgPrivacyParameters) {
	privacyParametersOffset = messageBuffer.indexOf (Encryption.PRIV_PARAMETERS_PLACEHOLDER);
	msgPrivacyParameters.copy (messageBuffer, privacyParametersOffset, 0, Encryption.DES_IV_LENGTH);
};

/*****************************************************************************
 ** Message class definition
 **/

var Message = function () {
}

Message.prototype.toBuffer = function () {
	if ( this.version == Version3 ) {
		return this.toBufferV3();
	} else {
		return this.toBufferCommunity();
	}
}

Message.prototype.toBufferCommunity = function () {
	if (this.buffer)
		return this.buffer;

	var writer = new ber.Writer ();

	writer.startSequence ();

	writer.writeInt (this.version);
	writer.writeString (this.community);

	this.pdu.toBuffer (writer);

	writer.endSequence ();

	this.buffer = writer.buffer;

	return this.buffer;
};

Message.prototype.toBufferV3 = function () {
	var encryptionResult;

	if (this.buffer)
		return this.buffer;

	var writer = new ber.Writer ();

	writer.startSequence ();

	writer.writeInt (this.version);

	// HeaderData
	writer.startSequence ();
	writer.writeInt (this.msgGlobalData.msgID);
	writer.writeInt (this.msgGlobalData.msgMaxSize);
	writer.writeByte (ber.OctetString);
	writer.writeByte (1);
	writer.writeByte (this.msgGlobalData.msgFlags);
	writer.writeInt (this.msgGlobalData.msgSecurityModel);
	writer.endSequence ();

	// msgSecurityParameters
	var msgSecurityParametersWriter = new ber.Writer ();
	msgSecurityParametersWriter.startSequence ();
	//msgSecurityParametersWriter.writeString (this.msgSecurityParameters.msgAuthoritativeEngineID);
	// writing a zero-length buffer fails - should fix asn1-ber for this condition
	if ( this.msgSecurityParameters.msgAuthoritativeEngineID.length == 0 ) {
		msgSecurityParametersWriter.writeString ("");
	} else {
		msgSecurityParametersWriter.writeBuffer (this.msgSecurityParameters.msgAuthoritativeEngineID, ber.OctetString);
	}
	msgSecurityParametersWriter.writeInt (this.msgSecurityParameters.msgAuthoritativeEngineBoots);
	msgSecurityParametersWriter.writeInt (this.msgSecurityParameters.msgAuthoritativeEngineTime);
	msgSecurityParametersWriter.writeString (this.msgSecurityParameters.msgUserName);

	if ( this.hasAuthentication() ) {
		msgSecurityParametersWriter.writeBuffer (Authentication.AUTH_PARAMETERS_PLACEHOLDER, ber.OctetString);
	// should never happen where msgFlags has no authentication but authentication parameters still present
	} else if ( this.msgSecurityParameters.msgAuthenticationParameters.length > 0 ) {
		msgSecurityParametersWriter.writeBuffer (this.msgSecurityParameters.msgAuthenticationParameters, ber.OctetString);
	} else {
	 	msgSecurityParametersWriter.writeString (this.msgSecurityParameters.msgAuthenticationParameters);
	}

	if ( this.hasPrivacy() ) {
		msgSecurityParametersWriter.writeBuffer (Encryption.PRIV_PARAMETERS_PLACEHOLDER, ber.OctetString);
	// should never happen where msgFlags has no privacy but privacy parameters still present
	} else if ( this.msgSecurityParameters.msgAuthenticationParameters.length > 0 ) {
		msgSecurityParametersWriter.writeBuffer (this.msgSecurityParameters.msgPrivacyParameters, ber.OctetString);
	} else {
	 	msgSecurityParametersWriter.writeString (this.msgSecurityParameters.msgPrivacyParameters);
	}
	msgSecurityParametersWriter.endSequence ();

	writer.writeBuffer (msgSecurityParametersWriter.buffer, ber.OctetString);

	// ScopedPDU
	var scopedPduWriter = new ber.Writer ();
	scopedPduWriter.startSequence ();
	if ( this.msgSecurityParameters.msgAuthoritativeEngineID.length == 0 ) {
		scopedPduWriter.writeString ("");
	} else {
		scopedPduWriter.writeBuffer (this.msgSecurityParameters.msgAuthoritativeEngineID, ber.OctetString);
	}
	scopedPduWriter.writeString ("");
	this.pdu.toBuffer (scopedPduWriter);
	scopedPduWriter.endSequence ();

	if ( this.hasPrivacy() ) {
		encryptionResult = Encryption.encryptPdu(scopedPduWriter.buffer, this.user.privProtocol, this.user.privKey, this.user.authProtocol, this.msgSecurityParameters.msgAuthoritativeEngineID);
		writer.writeBuffer (encryptionResult.encryptedPdu, ber.OctetString);
	} else {
		writer.writeBuffer (scopedPduWriter.buffer);
	}

	writer.endSequence ();

	this.buffer = writer.buffer;

	if ( this.hasPrivacy() ) {
		Encryption.addParametersToMessageBuffer(this.buffer, encryptionResult.msgPrivacyParameters);
	}

	if ( this.hasAuthentication() ) {
		Authentication.addParametersToMessageBuffer(this.buffer, this.user.authProtocol, this.user.authKey,
			this.msgSecurityParameters.msgAuthoritativeEngineID);
	}

	return this.buffer;
};

Message.prototype.getReqId = function () {
	return this.version == Version3 ? this.msgGlobalData.msgID : this.pdu.id;
};

Message.prototype.hasAuthentication = function () {
	return this.msgGlobalData && this.msgGlobalData.msgFlags && this.msgGlobalData.msgFlags & 1;
};

Message.prototype.hasPrivacy = function () {
	return this.msgGlobalData && this.msgGlobalData.msgFlags && this.msgGlobalData.msgFlags & 2;
};

Message.createRequestCommunity = function (version, community, pdu) {
	var message = new Message();

	message.version = version;
	message.community = community;
	message.pdu = pdu;

	return message;
};

Message.createRequestV3 = function (user, msgSecurityParameters, pdu) {
	var message = new Message();
	var authFlag = user.level == UsmLevel.authNoPriv || user.level == UsmLevel.authPriv ? 1 : 0;
	var privFlag = user.level == UsmLevel.authPriv ? 1 : 0;
	var reportableFlag = 1; // all request messages are reportable

	message.version = 3;
	message.user = user;
	message.msgGlobalData = {
		msgID: _generateId(), // random ID
		msgMaxSize: 65507,
		msgFlags: reportableFlag * 4 | privFlag * 2 | authFlag * 1,
		msgSecurityModel: 3
	};
	message.msgSecurityParameters = {
		msgAuthoritativeEngineID: msgSecurityParameters.msgAuthoritativeEngineID || Buffer.from(""),
		msgAuthoritativeEngineBoots: msgSecurityParameters.msgAuthoritativeEngineBoots || 0,
		msgAuthoritativeEngineTime: msgSecurityParameters.msgAuthoritativeEngineTime || 0,
		msgUserName: user.name || "",
		msgAuthenticationParameters: "",
		msgPrivacyParameters: ""
	}
	message.pdu = pdu;

	return message;
};

Message.createDiscoveryV3 = function (pdu) {
	var msgSecurityParameters = {
		msgAuthoritativeEngineID: Buffer.from(""),
		msgAuthoritativeEngineBoots: 0,
		msgAuthoritativeEngineTime: 0
	};
	var emptyUser = {
		name: "",
		level: 1
	};
	return Message.createRequestV3 (emptyUser, msgSecurityParameters, pdu);
}

Message.createResponse = function (buffer, reqs) {
	var reader = new ber.Reader (buffer);
	var message = new Message();

	reader.readSequence ();

	message.version = reader.readInt ();

	if (message.version != 3) {
		message.community = reader.readString ();
		message.pdu = readPdu(reader, false);
	} else {
		// HeaderData
		message.msgGlobalData = {};
		reader.readSequence ();
		message.msgGlobalData.msgID = reader.readInt ();
		message.msgGlobalData.msgMaxSize = reader.readInt ();
		message.msgGlobalData.msgFlags = reader.readString (ber.OctetString, true)[0];
		message.msgGlobalData.msgSecurityModel = reader.readInt ();

		// msgSecurityParameters
		message.msgSecurityParameters = {};
		var msgSecurityParametersReader = new ber.Reader (reader.readString (ber.OctetString, true));
		msgSecurityParametersReader.readSequence ();
		message.msgSecurityParameters.msgAuthoritativeEngineID = msgSecurityParametersReader.readString (ber.OctetString, true);
		message.msgSecurityParameters.msgAuthoritativeEngineBoots = msgSecurityParametersReader.readInt ();
		message.msgSecurityParameters.msgAuthoritativeEngineTime = msgSecurityParametersReader.readInt ();
		message.msgSecurityParameters.msgUserName = msgSecurityParametersReader.readString ();
		message.msgSecurityParameters.msgAuthenticationParameters = Buffer.from(msgSecurityParametersReader.readString (ber.OctetString, true));
		message.msgSecurityParameters.msgPrivacyParameters = Buffer.from(msgSecurityParametersReader.readString (ber.OctetString, true));
		scopedPdu = true;

		if ( message.hasPrivacy() ) {
			var encryptedPdu = reader.readString (ber.OctetString, true);
			var user = reqs[message.msgGlobalData.msgID].message.user;
			var decryptedPdu = Encryption.decryptPdu(encryptedPdu, user.privProtocol,
				message.msgSecurityParameters.msgPrivacyParameters, user.privKey, user.authProtocol,
				message.msgSecurityParameters.msgAuthoritativeEngineID);
			var decryptedPduReader = new ber.Reader (decryptedPdu);
			message.pdu = readPdu(decryptedPduReader, true);		
		} else {
			message.pdu = readPdu(reader, true);
		}
	}

	return message;
};

var Req = function (session, message, pdu, feedCb, responseCb, options) {

	this.message = message;
	this.responseCb = responseCb;
	this.retries = session.retries;
	this.timeout = session.timeout;
	this.onResponse = session.onSimpleGetResponse;
	this.feedCb = feedCb;
	this.port = (options && options.port) ? options.port : session.port;

};

Req.prototype.getId = function() {
	return this.message.getReqId ();
}


/*****************************************************************************
 ** Session class definition
 **/

var Session = function (target, authenticator, options) {
	this.target = target || "127.0.0.1";

	this.version = (options && options.version)
			? options.version
			: Version1;

	if ( this.version == Version3 ) {
		this.user = authenticator;
	} else {
		this.community = authenticator || "public";
	}

	this.transport = (options && options.transport)
			? options.transport
			: "udp4";
	this.port = (options && options.port )
			? options.port
			: 161;
	this.trapPort = (options && options.trapPort )
			? options.trapPort
			: 162;

	this.retries = (options && (options.retries || options.retries == 0))
			? options.retries
			: 1;
	this.timeout = (options && options.timeout)
			? options.timeout
			: 5000;

	this.sourceAddress = (options && options.sourceAddress )
			? options.sourceAddress
			: undefined;
	this.sourcePort = (options && options.sourcePort )
			? parseInt(options.sourcePort)
			: undefined;

	this.idBitsSize = (options && options.idBitsSize)
			? parseInt(options.idBitsSize)
			: 32;

	this.reqs = {};
	this.reqCount = 0;

	this.dgram = dgram.createSocket (this.transport);
	this.dgram.unref();
	
	var me = this;
	this.dgram.on ("message", me.onMsg.bind (me));
	this.dgram.on ("close", me.onClose.bind (me));
	this.dgram.on ("error", me.onError.bind (me));

	if (this.sourceAddress || this.sourcePort)
		this.dgram.bind (this.sourcePort, this.sourceAddress);
};

util.inherits (Session, events.EventEmitter);

Session.prototype.close = function () {
	this.dgram.close ();
	return this;
};

Session.prototype.cancelRequests = function (error) {
	var id;
	for (id in this.reqs) {
		var req = this.reqs[id];
		this.unregisterRequest (req.getId ());
		req.responseCb (error);
	}
};

function _generateId (bitSize) {
	if (bitSize === 16) {
		return Math.floor(Math.random() * 10000) % 65535;
	}
	return Math.floor(Math.random() * 100000000) % 4294967295;
}

Session.prototype.get = function (oids, responseCb) {
	function feedCb (req, message) {
		var pdu = message.pdu;
		var varbinds = [];

		if (req.message.pdu.varbinds.length != pdu.varbinds.length) {
			req.responseCb (new ResponseInvalidError ("Requested OIDs do not "
					+ "match response OIDs"));
		} else {
			for (var i = 0; i < req.message.pdu.varbinds.length; i++) {
				if (req.message.pdu.varbinds[i].oid != pdu.varbinds[i].oid) {
					req.responseCb (new ResponseInvalidError ("OID '"
							+ req.message.pdu.varbinds[i].oid
							+ "' in request at positiion '" + i + "' does not "
							+ "match OID '" + pdu.varbinds[i].oid + "' in response "
							+ "at position '" + i + "'"));
					return;
				} else {
					varbinds.push (pdu.varbinds[i]);
				}
			}

			req.responseCb (null, varbinds);
		}
	}

	var pduVarbinds = [];

	for (var i = 0; i < oids.length; i++) {
		var varbind = {
			oid: oids[i]
		};
		pduVarbinds.push (varbind);
	}

	this.simpleGet (GetRequestPdu, feedCb, pduVarbinds, responseCb);

	return this;
};

Session.prototype.getBulk = function () {
	var oids, nonRepeaters, maxRepetitions, responseCb;

	if (arguments.length >= 4) {
		oids = arguments[0];
		nonRepeaters = arguments[1];
		maxRepetitions = arguments[2];
		responseCb = arguments[3];
	} else if (arguments.length >= 3) {
		oids = arguments[0];
		nonRepeaters = arguments[1];
		maxRepetitions = 10;
		responseCb = arguments[2];
	} else {
		oids = arguments[0];
		nonRepeaters = 0;
		maxRepetitions = 10;
		responseCb = arguments[1];
	}

	function feedCb (req, message) {
		var pdu = message.pdu;
		var varbinds = [];
		var i = 0;

		// first walk through and grab non-repeaters
		if (pdu.varbinds.length < nonRepeaters) {
			req.responseCb (new ResponseInvalidError ("Varbind count in "
					+ "response '" + pdu.varbinds.length + "' is less than "
					+ "non-repeaters '" + nonRepeaters + "' in request"));
		} else {
			for ( ; i < nonRepeaters; i++) {
				if (isVarbindError (pdu.varbinds[i])) {
					varbinds.push (pdu.varbinds[i]);
				} else if (! oidFollowsOid (req.message.pdu.varbinds[i].oid,
						pdu.varbinds[i].oid)) {
					req.responseCb (new ResponseInvalidError ("OID '"
							+ req.message.pdu.varbinds[i].oid + "' in request at "
							+ "positiion '" + i + "' does not precede "
							+ "OID '" + pdu.varbinds[i].oid + "' in response "
							+ "at position '" + i + "'"));
					return;
				} else {
					varbinds.push (pdu.varbinds[i]);
				}
			}
		}

		var repeaters = req.message.pdu.varbinds.length - nonRepeaters;

		// secondly walk through and grab repeaters
		if (pdu.varbinds.length % (repeaters)) {
			req.responseCb (new ResponseInvalidError ("Varbind count in "
					+ "response '" + pdu.varbinds.length + "' is not a "
					+ "multiple of repeaters '" + repeaters
					+ "' plus non-repeaters '" + nonRepeaters + "' in request"));
		} else {
			while (i < pdu.varbinds.length) {
				for (var j = 0; j < repeaters; j++, i++) {
					var reqIndex = nonRepeaters + j;
					var respIndex = i;

					if (isVarbindError (pdu.varbinds[respIndex])) {
						if (! varbinds[reqIndex])
							varbinds[reqIndex] = [];
						varbinds[reqIndex].push (pdu.varbinds[respIndex]);
					} else if (! oidFollowsOid (
							req.message.pdu.varbinds[reqIndex].oid,
							pdu.varbinds[respIndex].oid)) {
						req.responseCb (new ResponseInvalidError ("OID '"
								+ req.message.pdu.varbinds[reqIndex].oid
								+ "' in request at positiion '" + (reqIndex)
								+ "' does not precede OID '"
								+ pdu.varbinds[respIndex].oid
								+ "' in response at position '" + (respIndex) + "'"));
						return;
					} else {
						if (! varbinds[reqIndex])
							varbinds[reqIndex] = [];
						varbinds[reqIndex].push (pdu.varbinds[respIndex]);
					}
				}
			}
		}

		req.responseCb (null, varbinds);
	}

	var pduVarbinds = [];

	for (var i = 0; i < oids.length; i++) {
		var varbind = {
			oid: oids[i]
		};
		pduVarbinds.push (varbind);
	}

	var options = {
		nonRepeaters: nonRepeaters,
		maxRepetitions: maxRepetitions
	};

	this.simpleGet (GetBulkRequestPdu, feedCb, pduVarbinds, responseCb,
			options);

	return this;
};

Session.prototype.getNext = function (oids, responseCb) {
	function feedCb (req, message) {
		var pdu = message.pdu;
		var varbinds = [];

		if (req.message.pdu.varbinds.length != pdu.varbinds.length) {
			req.responseCb (new ResponseInvalidError ("Requested OIDs do not "
					+ "match response OIDs"));
		} else {
			for (var i = 0; i < req.message.pdu.varbinds.length; i++) {
				if (isVarbindError (pdu.varbinds[i])) {
					varbinds.push (pdu.varbinds[i]);
				} else if (! oidFollowsOid (req.message.pdu.varbinds[i].oid,
						pdu.varbinds[i].oid)) {
					req.responseCb (new ResponseInvalidError ("OID '"
							+ req.message.pdu.varbinds[i].oid + "' in request at "
							+ "positiion '" + i + "' does not precede "
							+ "OID '" + pdu.varbinds[i].oid + "' in response "
							+ "at position '" + i + "'"));
					return;
				} else {
					varbinds.push (pdu.varbinds[i]);
				}
			}

			req.responseCb (null, varbinds);
		}
	}

	var pduVarbinds = [];

	for (var i = 0; i < oids.length; i++) {
		var varbind = {
			oid: oids[i]
		};
		pduVarbinds.push (varbind);
	}

	this.simpleGet (GetNextRequestPdu, feedCb, pduVarbinds, responseCb);

	return this;
};

Session.prototype.inform = function () {
	var typeOrOid = arguments[0];
	var varbinds, options = {}, responseCb;

	/**
	 ** Support the following signatures:
	 ** 
	 **    typeOrOid, varbinds, options, callback
	 **    typeOrOid, varbinds, callback
	 **    typeOrOid, options, callback
	 **    typeOrOid, callback
	 **/
	if (arguments.length >= 4) {
		varbinds = arguments[1];
		options = arguments[2];
		responseCb = arguments[3];
	} else if (arguments.length >= 3) {
		if (arguments[1].constructor != Array) {
			varbinds = [];
			options = arguments[1];
			responseCb = arguments[2];
		} else {
			varbinds = arguments[1];
			responseCb = arguments[2];
		}
	} else {
		varbinds = [];
		responseCb = arguments[1];
	}

	function feedCb (req, message) {
		var pdu = message.pdu;
		var varbinds = [];

		if (req.message.pdu.varbinds.length != pdu.varbinds.length) {
			req.responseCb (new ResponseInvalidError ("Inform OIDs do not "
					+ "match response OIDs"));
		} else {
			for (var i = 0; i < req.message.pdu.varbinds.length; i++) {
				if (req.message.pdu.varbinds[i].oid != pdu.varbinds[i].oid) {
					req.responseCb (new ResponseInvalidError ("OID '"
							+ req.message.pdu.varbinds[i].oid
							+ "' in inform at positiion '" + i + "' does not "
							+ "match OID '" + pdu.varbinds[i].oid + "' in response "
							+ "at position '" + i + "'"));
					return;
				} else {
					varbinds.push (pdu.varbinds[i]);
				}
			}

			req.responseCb (null, varbinds);
		}
	}

	if (typeof typeOrOid != "string")
		typeOrOid = "1.3.6.1.6.3.1.1.5." + (typeOrOid + 1);

	var pduVarbinds = [
		{
			oid: "1.3.6.1.2.1.1.3.0",
			type: ObjectType.TimeTicks,
			value: options.upTime || Math.floor (process.uptime () * 100)
		},
		{
			oid: "1.3.6.1.6.3.1.1.4.1.0",
			type: ObjectType.OID,
			value: typeOrOid
		}
	];

	for (var i = 0; i < varbinds.length; i++) {
		var varbind = {
			oid: varbinds[i].oid,
			type: varbinds[i].type,
			value: varbinds[i].value
		};
		pduVarbinds.push (varbind);
	}
	
	options.port = this.trapPort;

	this.simpleGet (InformRequestPdu, feedCb, pduVarbinds, responseCb, options);

	return this;
};

Session.prototype.onClose = function () {
	this.cancelRequests (new Error ("Socket forcibly closed"));
	this.emit ("close");
};

Session.prototype.onError = function (error) {
	this.emit (error);
};

Session.prototype.onMsg = function (buffer) {
	try {
		var message = Message.createResponse (buffer, this.reqs);

		var req = this.unregisterRequest (message.getReqId ());
		if (! req)
			return;

		if ( message.hasAuthentication() ) {
			if ( ! Authentication.isAuthentic(buffer, this.user.authProtocol, this.user.authKey,
					message.msgSecurityParameters.msgAuthoritativeEngineID, message.msgSecurityParameters.msgAuthenticationParameters) ) {
				req.responseCb (new ResponseInvalidError ("Authentication digest "
						+ message.msgSecurityParameters.msgAuthenticationParameters.toString ('hex')
						+ " received in message does not match digest "
						+ Authentication.calculateDigest (buffer, this.user.authProtocol,this.user.authKey,
							message.msgSecurityParameters.msgAuthoritativeEngineID).toString ('hex')
						+ " calculated for message") );
				return;
			}
		}
		
		try {
			if (message.version != req.message.version) {
				req.responseCb (new ResponseInvalidError ("Version in request '"
						+ req.message.version + "' does not match version in "
						+ "response '" + message.version + "'"));
			} else if (message.community != req.message.community) {
				req.responseCb (new ResponseInvalidError ("Community '"
						+ req.message.community + "' in request does not match "
						+ "community '" + message.community + "' in response"));
			} else if (message.pdu.type == PduType.GetResponse) {
				req.onResponse (req, message);
			} else if (message.pdu.type == PduType.Report) {
				if ( ! req.originalPdu ) {
					req.responseCb (new ResponseInvalidError ("Unexpected Report PDU") );
					return;
				}
				var msgSecurityParameters = {
					msgAuthoritativeEngineID: message.msgSecurityParameters.msgAuthoritativeEngineID,
					msgAuthoritativeEngineBoots: message.msgSecurityParameters.msgAuthoritativeEngineBoots,
					msgAuthoritativeEngineTime: message.msgSecurityParameters.msgAuthoritativeEngineTime
				};
				var messageForOriginalPdu = Message.createRequestV3 (this.user, msgSecurityParameters, req.originalPdu);
				var reqForOriginalPduOptions = req.options || {};
				reqForOriginalPduOptions.port = req.port;
				var reqForOriginalPdu = new Req (this, messageForOriginalPdu, req.originalPdu, req.feedCb, req.responseCb, reqForOriginalPduOptions);
				this.send(reqForOriginalPdu);
			} else {
				req.responseCb (new ResponseInvalidError ("Unknown PDU type '"
						+ message.pdu.type + "' in response"));
			}
		} catch (error) {
			req.responseCb (error);
		}
	} catch (error) {
		this.emit("error", error);
	}
};

Session.prototype.onSimpleGetResponse = function (req, message) {
	var pdu = message.pdu;

	if (pdu.errorStatus > 0) {
		var statusString = ErrorStatus[pdu.errorStatus]
				|| ErrorStatus.GeneralError;
		var statusCode = ErrorStatus[statusString]
				|| ErrorStatus[ErrorStatus.GeneralError];

		if (pdu.errorIndex <= 0 || pdu.errorIndex > pdu.varbinds.length) {
			req.responseCb (new RequestFailedError (statusString, statusCode));
		} else {
			var oid = pdu.varbinds[pdu.errorIndex - 1].oid;
			var error = new RequestFailedError (statusString + ": " + oid,
					statusCode);
			req.responseCb (error);
		}
	} else {
		req.feedCb (req, message);
	}
};

Session.prototype.registerRequest = function (req) {
	if (! this.reqs[req.getId ()]) {
		this.reqs[req.getId ()] = req;
		if (this.reqCount <= 0)
			this.dgram.ref();
		this.reqCount++;
	}
	var me = this;
	req.timer = setTimeout (function () {
		if (req.retries-- > 0) {
			me.send (req);
		} else {
			me.unregisterRequest (req.getId ());
			req.responseCb (new RequestTimedOutError (
					"Request timed out"));
		}
	}, req.timeout);
};

Session.prototype.send = function (req, noWait) {
	try {
		var me = this;
		
		var buffer = req.message.toBuffer ();

		this.dgram.send (buffer, 0, buffer.length, req.port, this.target,
				function (error, bytes) {
			if (error) {
				req.responseCb (error);
			} else {
				if (noWait) {
					req.responseCb (null);
				} else {
					me.registerRequest (req);
				}
			}
		});
	} catch (error) {
		req.responseCb (error);
	}
	
	return this;
};

Session.prototype.set = function (varbinds, responseCb) {
	function feedCb (req, message) {
		var pdu = message.pdu;
		var varbinds = [];

		if (req.message.pdu.varbinds.length != pdu.varbinds.length) {
			req.responseCb (new ResponseInvalidError ("Requested OIDs do not "
					+ "match response OIDs"));
		} else {
			for (var i = 0; i < req.message.pdu.varbinds.length; i++) {
				if (req.message.pdu.varbinds[i].oid != pdu.varbinds[i].oid) {
					req.responseCb (new ResponseInvalidError ("OID '"
							+ req.message.pdu.varbinds[i].oid
							+ "' in request at positiion '" + i + "' does not "
							+ "match OID '" + pdu.varbinds[i].oid + "' in response "
							+ "at position '" + i + "'"));
					return;
				} else {
					varbinds.push (pdu.varbinds[i]);
				}
			}

			req.responseCb (null, varbinds);
		}
	}

	var pduVarbinds = [];

	for (var i = 0; i < varbinds.length; i++) {
		var varbind = {
			oid: varbinds[i].oid,
			type: varbinds[i].type,
			value: varbinds[i].value
		};
		pduVarbinds.push (varbind);
	}

	this.simpleGet (SetRequestPdu, feedCb, pduVarbinds, responseCb);

	return this;
};

Session.prototype.simpleGet = function (pduClass, feedCb, varbinds,
		responseCb, options) {
	try {
		var id = _generateId (this.idBitsSize);
		var pdu = new pduClass (id, varbinds, options);
		var message;
		var req;

		if ( this.version == Version3 ) {
			// SNMPv3 discovery
			var discoveryPdu = createDiscoveryPdu();
			var discoveryMessage = Message.createDiscoveryV3 (discoveryPdu);
			var discoveryReq = new Req (this, discoveryMessage, discoveryPdu, feedCb, responseCb, options);
			discoveryReq.originalPdu = pdu;
			this.send (discoveryReq);
		} else {
			message = Message.createRequestCommunity (this.version, this.community, pdu);
			req = new Req (this, message, pdu, feedCb, responseCb, options);
			this.send (req);
		}
	} catch (error) {
		if (responseCb)
			responseCb (error);
	}
}

function subtreeCb (req, varbinds) {
	var done = 0;

	for (var i = varbinds.length; i > 0; i--) {
		if (! oidInSubtree (req.baseOid, varbinds[i - 1].oid)) {
			done = 1;
			varbinds.pop ();
		}
	}

	if (varbinds.length > 0)
		req.feedCb (varbinds);

	if (done)
		return true;
}

Session.prototype.subtree  = function () {
	var me = this;
	var oid = arguments[0];
	var maxRepetitions, feedCb, doneCb;

	if (arguments.length < 4) {
		maxRepetitions = 20;
		feedCb = arguments[1];
		doneCb = arguments[2];
	} else {
		maxRepetitions = arguments[1];
		feedCb = arguments[2];
		doneCb = arguments[3];
	}

	var req = {
		feedCb: feedCb,
		doneCb: doneCb,
		maxRepetitions: maxRepetitions,
		baseOid: oid
	};

	this.walk (oid, maxRepetitions, subtreeCb.bind (me, req), doneCb);

	return this;
};

function tableColumnsResponseCb (req, error) {
	if (error) {
		req.responseCb (error);
	} else if (req.error) {
		req.responseCb (req.error);
	} else {
		if (req.columns.length > 0) {
			var column = req.columns.pop ();
			var me = this;
			this.subtree (req.rowOid + column, req.maxRepetitions,
					tableColumnsFeedCb.bind (me, req),
					tableColumnsResponseCb.bind (me, req));
		} else {
			req.responseCb (null, req.table);
		}
	}
}

function tableColumnsFeedCb (req, varbinds) {
	for (var i = 0; i < varbinds.length; i++) {
		if (isVarbindError (varbinds[i])) {
			req.error = new RequestFailedError (varbindError (varbind[i]));
			return true;
		}

		var oid = varbinds[i].oid.replace (req.rowOid, "");
		if (oid && oid != varbinds[i].oid) {
			var match = oid.match (/^(\d+)\.(.+)$/);
			if (match && match[1] > 0) {
				if (! req.table[match[2]])
					req.table[match[2]] = {};
				req.table[match[2]][match[1]] = varbinds[i].value;
			}
		}
	}
}

Session.prototype.tableColumns = function () {
	var me = this;

	var oid = arguments[0];
	var columns = arguments[1];
	var maxRepetitions, responseCb;

	if (arguments.length < 4) {
		responseCb = arguments[2];
		maxRepetitions = 20;
	} else {
		maxRepetitions = arguments[2];
		responseCb = arguments[3];
	}

	var req = {
		responseCb: responseCb,
		maxRepetitions: maxRepetitions,
		baseOid: oid,
		rowOid: oid + ".1.",
		columns: columns.slice(0),
		table: {}
	};

	if (req.columns.length > 0) {
		var column = req.columns.pop ();
		this.subtree (req.rowOid + column, maxRepetitions,
				tableColumnsFeedCb.bind (me, req),
				tableColumnsResponseCb.bind (me, req));
	}

	return this;
};

function tableResponseCb (req, error) {
	if (error)
		req.responseCb (error);
	else if (req.error)
		req.responseCb (req.error);
	else
		req.responseCb (null, req.table);
}

function tableFeedCb (req, varbinds) {
	for (var i = 0; i < varbinds.length; i++) {
		if (isVarbindError (varbinds[i])) {
			req.error = new RequestFailedError (varbindError (varbind[i]));
			return true;
		}

		var oid = varbinds[i].oid.replace (req.rowOid, "");
		if (oid && oid != varbinds[i].oid) {
			var match = oid.match (/^(\d+)\.(.+)$/);
			if (match && match[1] > 0) {
				if (! req.table[match[2]])
					req.table[match[2]] = {};
				req.table[match[2]][match[1]] = varbinds[i].value;
			}
		}
	}
}

Session.prototype.table = function () {
	var me = this;

	var oid = arguments[0];
	var maxRepetitions, responseCb;

	if (arguments.length < 3) {
		responseCb = arguments[1];
		maxRepetitions = 20;
	} else {
		maxRepetitions = arguments[1];
		responseCb = arguments[2];
	}

	var req = {
		responseCb: responseCb,
		maxRepetitions: maxRepetitions,
		baseOid: oid,
		rowOid: oid + ".1.",
		table: {}
	};

	this.subtree (oid, maxRepetitions, tableFeedCb.bind (me, req),
			tableResponseCb.bind (me, req));

	return this;
};

Session.prototype.trap = function () {
	var req = {};

	try {
		var typeOrOid = arguments[0];
		var varbinds, options = {}, responseCb;
		var message;

		/**
		 ** Support the following signatures:
		 ** 
		 **    typeOrOid, varbinds, options, callback
		 **    typeOrOid, varbinds, agentAddr, callback
		 **    typeOrOid, varbinds, callback
		 **    typeOrOid, agentAddr, callback
		 **    typeOrOid, options, callback
		 **    typeOrOid, callback
		 **/
		if (arguments.length >= 4) {
			varbinds = arguments[1];
			if (typeof arguments[2] == "string") {
				options.agentAddr = arguments[2];
			} else if (arguments[2].constructor != Array) {
				options = arguments[2];
			}
			responseCb = arguments[3];
		} else if (arguments.length >= 3) {
			if (typeof arguments[1] == "string") {
				varbinds = [];
				options.agentAddr = arguments[1];
			} else if (arguments[1].constructor != Array) {
				varbinds = [];
				options = arguments[1];
			} else {
				varbinds = arguments[1];
				agentAddr = null;
			}
			responseCb = arguments[2];
		} else {
			varbinds = [];
			responseCb = arguments[1];
		}

		var pdu, pduVarbinds = [];

		for (var i = 0; i < varbinds.length; i++) {
			var varbind = {
				oid: varbinds[i].oid,
				type: varbinds[i].type,
				value: varbinds[i].value
			};
			pduVarbinds.push (varbind);
		}
		
		var id = _generateId (this.idBitsSize);

		if (this.version == Version2c || this.version == Version3 ) {
			if (typeof typeOrOid != "string")
				typeOrOid = "1.3.6.1.6.3.1.1.5." + (typeOrOid + 1);

			pduVarbinds.unshift (
				{
					oid: "1.3.6.1.2.1.1.3.0",
					type: ObjectType.TimeTicks,
					value: options.upTime || Math.floor (process.uptime () * 100)
				},
				{
					oid: "1.3.6.1.6.3.1.1.4.1.0",
					type: ObjectType.OID,
					value: typeOrOid
				}
			);

			pdu = new TrapV2Pdu (id, pduVarbinds, options);
		} else {
			pdu = new TrapPdu (typeOrOid, pduVarbinds, options);
		}

		if ( this.version == Version3 ) {
			var msgSecurityParameters = {
				//msgAuthoritativeEngineID: Buffer.from(this.user.engineID, 'hex'),
				msgAuthoritativeEngineID: this.user.engineID,
				msgAuthoritativeEngineBoots: 0,
				msgAuthoritativeEngineTime: 0
			};
			message = Message.createRequestV3 (this.user, msgSecurityParameters, pdu);
		} else {
			message = Message.createRequestCommunity (this.version, this.community, pdu);
		}

		req = {
			id: id,
			message: message,
			responseCb: responseCb,
			port: this.trapPort
		};

		this.send (req, true);
	} catch (error) {
		if (req.responseCb)
			req.responseCb (error);
	}

	return this;
};

Session.prototype.unregisterRequest = function (id) {
	var req = this.reqs[id];
	if (req) {
		delete this.reqs[id];
		clearTimeout (req.timer);
		delete req.timer;
		this.reqCount--;
		if (this.reqCount <= 0)
			this.dgram.unref();
		return req;
	} else {
		return null;
	}
};

function walkCb (req, error, varbinds) {
	var done = 0;
	var oid;

	if (error) {
		if (error instanceof RequestFailedError) {
			if (error.status != ErrorStatus.NoSuchName) {
				req.doneCb (error);
				return;
			} else {
				// signal the version 1 walk code below that it should stop
				done = 1;
			}
		} else {
			req.doneCb (error);
			return;
		}
	}

	if (this.version == Version2c || this.version == Version3 ) {
		for (var i = varbinds[0].length; i > 0; i--) {
			if (varbinds[0][i - 1].type == ObjectType.EndOfMibView) {
				varbinds[0].pop ();
				done = 1;
			}
		}
		if (req.feedCb (varbinds[0]))
			done = 1;
		if (! done)
			oid = varbinds[0][varbinds[0].length - 1].oid;
	} else {
		if (! done) {
			if (req.feedCb (varbinds)) {
				done = 1;
			} else {
				oid = varbinds[0].oid;
			}
		}
	}

	if (done)
		req.doneCb (null);
	else
		this.walk (oid, req.maxRepetitions, req.feedCb, req.doneCb,
				req.baseOid);
}

Session.prototype.walk  = function () {
	var me = this;
	var oid = arguments[0];
	var maxRepetitions, feedCb, doneCb, baseOid;

	if (arguments.length < 4) {
		maxRepetitions = 20;
		feedCb = arguments[1];
		doneCb = arguments[2];
	} else {
		maxRepetitions = arguments[1];
		feedCb = arguments[2];
		doneCb = arguments[3];
	}

	var req = {
		maxRepetitions: maxRepetitions,
		feedCb: feedCb,
		doneCb: doneCb
	};

	if (this.version == Version2c || this.version == Version3)
		this.getBulk ([oid], 0, maxRepetitions,
				walkCb.bind (me, req));
	else
		this.getNext ([oid], walkCb.bind (me, req));

	return this;
};

/*****************************************************************************
 ** Exports
 **/

exports.Session = Session;

exports.createSession = function (target, community, options) {
	if ( options.version && ! ( options.version == Version1 || options.version == Version2c ) ) {
		throw new ResponseInvalidError ("SNMP community session requested but version '" + options.version + "' specified in options not valid");
	} else {
		return new Session (target, community, options);
	}
};

exports.createV3Session = function (target, user, options) {
	if ( options.version && options.version != Version3 ) {
		throw new ResponseInvalidError ("SNMPv3 session requested but version '" + options.version + "' specified in options");
	} else {
		options.version = Version3;
	}
	return new Session (target, user, options);
};

exports.isVarbindError = isVarbindError;
exports.varbindError = varbindError;

exports.Version1 = Version1;
exports.Version2c = Version2c;
exports.Version3 = Version3;
exports.Version = Version;

exports.ErrorStatus = ErrorStatus;
exports.TrapType = TrapType;
exports.ObjectType = ObjectType;
exports.UsmLevel = UsmLevel;
exports.UsmAuthProtocol = UsmAuthProtocol;
exports.UsmPrivProtocol = UsmPrivProtocol;

exports.ResponseInvalidError = ResponseInvalidError;
exports.RequestInvalidError = RequestInvalidError;
exports.RequestFailedError = RequestFailedError;
exports.RequestTimedOutError = RequestTimedOutError;

/**
 ** We've added this for testing.
 **/
exports.ObjectParser = {
	readInt: readInt,
	readUint: readUint
};
exports.Authentication = Authentication;
