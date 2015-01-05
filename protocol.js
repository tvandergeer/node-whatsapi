var util   = require('util');
var buffer = require('buffer');
var common = require('./common');

function Buffer() {
	Buffer.super_.apply(this, arguments);
}

util.inherits(Buffer, buffer.Buffer);

Buffer.concat = function(buffers, len) {
	if(!len) {
		len = 0;
		
		for (var i = 0; i < buffers.length; i++) {
			len += buffers[i].length;
		};
	}

	var result = new Buffer(len);
	var offset = 0;
	
	for (var i = 0; i < buffers.length; i++) {
		buffers[i].copy(result, offset);

		offset += buffers[i].length;
	};

	return result;
};

Buffer.isBuffer = function(target) {
	return target instanceof Buffer;
};

Buffer.fromBuffer = function(buffer) {
	var buff = new Buffer(buffer.length);
	buffer.copy(buff);

	return buff;
};

Buffer.prototype.slice = function() {
	return Buffer.fromBuffer(Buffer.super_.prototype.slice.apply(this, arguments));
};

Buffer.prototype.writeUInt24BE = function(uint, position) {
	position = position || 0;

	this.writeUInt8((uint & 0xff0000) >> 16, position);
	this.writeUInt8((uint & 0x00ff00) >> 8, ++position);
	this.writeUInt8((uint & 0x0000ff) >> 0, ++position);
};

Buffer.prototype.readUInt24BE = function(position) {
	position = position || 0;

	return this[position] << 16 | this[++position] << 8 | this[++position] << 0;
};

Buffer.prototype.toByteArray = function() {
	var byteArray = [];

	for(var i = 0, len = this.length; i < len; i++) {
		byteArray.push(this[i]);
	}

	return byteArray;
};

Buffer.prototype.toBuffer = function() {
	var nodebuffer = new buffer.Buffer(this.length);
	this.copy(nodebuffer);

	return nodebuffer;
};

Buffer.prototype.toString = function(enconding, start, len) {
	if(enconding || start || len) {
		return Buffer.super_.prototype.toString.apply(this, arguments);
	}

	return '[WhatsApp Buffer]';
};

function Node(tag, attributes, children, data) {
	this.contents = {
		tag        : tag,
		attributes : attributes || null,
		children   : children || [],
		data       : data || ''
	};
}

Node.prototype.tag = function() {
	return this.contents.tag;
};

Node.prototype.attributes = function() {
	return this.contents.attributes;
};

Node.prototype.children = function() {
	return this.contents.children;
};

Node.prototype.attribute = function(attribute) {
	return this.contents.attributes &&
		   this.contents.attributes.hasOwnProperty(attribute) &&
		   this.contents.attributes[attribute];
};

Node.prototype.child = function(key) {
	if(/^\d+$/.test(key)) {
		return this.contents.children.hasOwnProperty(key) && this.contents.children[key];
	}

	for(var i = 0, len = this.contents.children.length; i < len; i++) {
		if(this.contents.children[i].tag() == key) {
			return this.contents.children[i];
		}
	}

	return null;
};

Node.prototype.data = function() {
	return this.contents.data;
};

Node.prototype.shouldBeReplied = function() {
	return this.tag() === 'message'
		&& (this.child('notify') || this.child('received') || this.child('request'));
};

Node.prototype.isChallenge = function() {
	return this.tag() === 'challenge';
};

Node.prototype.isSuccess = function() {
	return this.tag() === 'success';
};

Node.prototype.isTyping = function() {
	return this.tag() === 'message' && (this.contents.children[0].contents.tag === 'composing' || this.contents.children[0].contents.tag === 'paused');
};

Node.prototype.isMessage = function() {
	return this.tag() === 'message' && this.child('notify') &&
		   this.child('notify').attribute('name') !== null;
};

Node.prototype.isPing = function() {
	return this.tag() === 'iq' && this.attribute('type') === 'get' && this.child(0).tag() === 'ping';
};

Node.prototype.isAvailable = function() {
	return this.tag() === 'presence' && (this.attribute('type') === 'available' || this.attribute('type') === 'unavailable');
}

Node.prototype.isDirtyPresence = function() {
	return this.tag() === 'presence' && this.attribute('status') === 'dirty';
};

Node.prototype.isMediaReady = function() {
	return this.tag() === 'iq' && this.attribute('type') === 'result' &&
		   this.child(0) && ['media', 'duplicate'].indexOf(this.child(0).tag()) !== -1;
};

Node.prototype.isGroupList = function() {
	return this.tag() === 'iq' && this.attribute('type') === 'result' && this.child('group');
};

Node.prototype.isGroupAdd = function() {
	return this.tag() === 'message' && this.attribute('type') === 'subject' && this.child('body') &&
		   this.child('body').attribute('event') === 'add';
};

Node.prototype.isGroupTopic = function() {
	return this.tag() === 'message' && this.attribute('type') === 'subject' && this.child('body');
};

Node.prototype.isGroupMembers = function() {
	return this.tag() === 'iq' && this.attribute('type') === 'result' && this.child(0)
		&& this.child(0).tag() === 'participant' && this.child(0).attribute('xmlns') === 'w:g';
};

Node.prototype.isGroupNewcomer = function() {
	return this.tag() === 'presence' && this.attribute('xmlns') === 'w' && this.attribute('add');
};

Node.prototype.isGroupOutcomer = function() {
	return this.tag() === 'presence' && this.attribute('xmlns') === 'w' && this.attribute('remove');
};

Node.prototype.isSync = function() {
	return this.tag() === 'iq' && this.child('sync');
};

Node.prototype.isLastSeen = function() {
	return this.child('query') && this.child('query').attribute('xmlns') === 'jabber:iq:last';
};

Node.prototype.isNotFound = function() {
	return this.tag() === 'iq' && this.child('error') &&
		   this.child('error').attribute('code') === '405';
};

Node.prototype.isFailure = function() {
	return this.tag() === 'failure';
};

Node.prototype.isReceived = function() {
	return this.tag() === 'message' && (this.child('received') || this.child('x'));
};

Node.prototype.isProfilePicture = function() {
	return this.tag() === 'iq' && this.child(0) && this.child(0).tag() === 'picture' && this.child('picture').data() && this.child(0).data().length >0;
};

Node.prototype.toXml = function(prefix) {
	prefix = prefix || '';

	var xml = "\n" + prefix;

	xml += '<' + this.contents.tag;

	if(this.contents.attributes !== null) {
		for(var key in this.contents.attributes) {
			if(this.contents.attributes.hasOwnProperty(key)) {
				xml += ' ' + key + '="' + this.contents.attributes[key] + '"';
			}
		}
	}

	xml += '>';

	if(this.contents.data) {
		xml += this.contents.data;
	}

	if(this.contents.children.length) {
		for (var i = 0; i < this.contents.children.length; i++) {
			xml += this.contents.children[i].toXml(prefix + '  ');
		};

		xml += "\n" + prefix;
	}

	xml += '</' + this.contents.tag + '>';

	return xml;
};

function Reader(dictionary) {
	this.dictionary = dictionary;
	this.setKey(null);
	this.input = null;
}

Reader.prototype.setKey = function(key) {
	this.key = key;
};

Reader.prototype.appendInput = function(input) {
	input = Buffer.fromBuffer(input);

	this.input = buffer.Buffer.isBuffer(this.input)
		? Buffer.concat([this.input, input], this.input.length + input.length)
		: input;
};

Reader.prototype.nextNode = function() {
	if(!this.input || !this.input.length) {
		return false;
	}

	var encrypted = ((this.peekInt8() & 0xF0) >> 4) & 8;
	var dataSize  = this.peekInt16(1);

	if(dataSize > this.input.length) {
		return false;
	}

	this.readInt24();

	if(encrypted) {
		if(this.key === null) {
			throw 'Encountered encrypted message, missing key';
		}

		var encoded = new buffer.Buffer(dataSize);

		this.input.copy(encoded, 0, 0, dataSize);

		var remaining = this.input.slice(dataSize);
		var decoded   = this.key.decode(encoded);

		this.input = Buffer.concat([decoded, remaining]);
	}

	return dataSize ? this.readNode() : null;
};

Reader.prototype.readNode = function() {
	var listSize = this.readListSize(this.readInt8());
	var token    = this.readInt8();

	if(token === 1) {
		return new Node('start', this.readAttributes(listSize));
	}

	if(token === 2) {
		return null;
	}

	var tag = this.readString(token);
	var attributes = this.readAttributes(listSize);

	if(listSize % 2 === 1) {
		return new Node(tag, attributes);
	}

	token = this.readInt8();

	var children;
	var data;

	this.isListToken(token) ? children = this.readList(token) : data = this.readString(token, true);

	return new Node(tag, attributes, children, data);
};

Reader.prototype.getToken = function(token) {
	if(this.dictionary.hasOwnProperty(token)) {
		return this.dictionary[token];
	}

	throw 'Unexpected token: ' + token;
};

Reader.prototype.readString = function(token, raw) {
	if(token === -1) {
		throw 'Invalid token';
	}

	if(token > 4 && token < 0xF5) {
		return this.getToken(token);
	}

	if(token === 0xFC) {
		return this.fillArray(this.readInt8(), raw);
	}

	if(token === 0xFD) {
		return this.fillArray(this.readInt24(), raw);
	}

	if(token === 0xFE) {
		return this.getToken(this.readInt8() + 0xF5);
	}

	if(token === 0xFA) {
		var user   = this.readString(this.readInt8());
		var server = this.readString(this.readInt8());

		return user.length ? user + '@' + server : server;
	}

	return '';
};

Reader.prototype.readAttributes = function(size) {
	var len = (size - 2 + size % 2) / 2;
	var attributes = {};

	while(len--) {
		var key = this.readString(this.readInt8());

		attributes[key] = this.readString(this.readInt8());
	}

	return attributes;
};

Reader.prototype.isListToken = function(token) {
	return [0, 0xF8, 0xF9].indexOf(token) !== -1;
};

Reader.prototype.readListSize = function(token) {
	if(token === 0xF8) {
		return this.readInt8();
	}

	if(token === 0xF9) {
		return this.readInt16();
	}

	throw 'Invalid token: ' + token;
};

Reader.prototype.readList = function(token) {
	var size = this.readListSize(token);
	var list = [];

	while(size--) {
		list.push(this.readNode());
	}

	return list;
};

Reader.prototype.fillArray = function(len, raw) {
	try {
		return raw ? this.input.slice(0, len).toBuffer() : this.input.toString(null, 0, len);
	} finally {
		this.input = this.input.slice(len);
	}
};

Reader.prototype.peekInt8 = function(offset) {
	offset = offset || 0;

	return this.input.readUInt8(offset);
};

Reader.prototype.readInt8 = function() {
	try {
		return this.peekInt8();
	} finally {
		this.input = this.input.slice(1);
	}
};

Reader.prototype.peekInt16 = function(offset) {
	offset = offset || 0;

	return this.input.readUInt16BE(offset);
};

Reader.prototype.readInt16 = function() {
	try {
		return this.peekInt16();
	} finally {
		this.input = this.input.slice(2);
	}
};

Reader.prototype.peekInt24 = function(offset) {
	offset = offset || 0;

	return this.input.readUInt24BE(offset);
};

Reader.prototype.readInt24 = function() {
	try {
		return this.peekInt24();
	} finally {
		this.input = this.input.slice(3);
	}
};

function Writer(dictionary) {
	this.dictionary = {};

	dictionary.forEach(function(token, index) {
		this.dictionary[token] = index;
	}, this);

	this.setKey(null);
}

Writer.prototype.setKey = function(key) {
	this.key = key;
};

Writer.prototype.initBuffer = function(len) {
	this.output = new Buffer(len);
	this.offset = 0;
};

Writer.prototype.stream = function(to, resource) {
	var header = new Buffer(4);

	header.write('WA');
	header.writeUInt8(1, 2);
	header.writeUInt8(2, 3);

	var attributes = {to : to, resource : resource};

	this.initBuffer(3 + this.getAttributesBufferLength(attributes));
	this.writeListStart(5);
	this.writeInt8(0x01);
	this.writeAttributes(attributes);

	var output = this.flush();

	return Buffer.concat([header, output], header.length + output.length).toBuffer();
};

Writer.prototype.node = function(node) {
	if(node === null) {
		this.initBuffer(1);
		this.writeInt8(0x00);
	} else {
		this.initBuffer(this.getNodeBufferLength(node));
		this.writeNode(node);
	}

	return this.flush().toBuffer();
};

Writer.prototype.flush = function() {
	var output = this.output.toBuffer();

	if(this.key !== null) {
		output = this.key.encode(output);
	}

	var header = new Buffer(3);

	header.writeUInt8(this.key === null ? 0x00 : 0x10, 0);
	header.writeUInt16BE(output.length, 1);

	try {
		return Buffer.concat([header, output], header.length + output.length);
	} finally {
		this.output = null;
	}
};

Writer.prototype.writeNode = function(node) {
	var len = 1;

	if(node.attributes() !== null) {
		len += common.objSize(node.attributes()) * 2;
	}

	if(node.children().length) {
		++len;
	}

	if(node.data().length) {
		++len;
	}

	this.writeListStart(len);
	this.writeString(node.tag());
	this.writeAttributes(node.attributes());

	if(node.data().length) {
		this.writeBytes(node.data());
	}

	if(node.children().length) {
		this.writeListStart(node.children().length);

		node.children().forEach(function(node) {
			this.writeNode(node);
		}, this);
	}
};

Writer.prototype.writeListStart = function(len) {
	if(len === 0) {
		this.writeInt8(0x00);
	}

	if(len < 0x100) {
		this.writeInt8(0xF8);
	} else {
		this.writeInt8(0xF9);
	}

	this.writeInt8(len);
};

Writer.prototype.writeAttributes = function(attributes) {
	if(attributes === null) {
		return;
	}

	for(var key in attributes) {
		if(attributes.hasOwnProperty(key)) {
			this.writeString(key);
			this.writeString(attributes[key]);
		}
	}
};

Writer.prototype.writeString = function(string) {
	if(this.dictionary.hasOwnProperty(string)) {
		return this.writeToken(this.dictionary[string]);
	}

	var index = string.indexOf('@');

	if(index !== -1) {
		var user   = string.slice(0, index);
		var server = string.slice(index + 1);
		return this.writeJid(user, server);
	}

	return this.writeBytes(string);
};

Writer.prototype.writeToken = function(token) {
	if(token < 0xF5) {
		return this.writeInt8(token);
	}

	if(token < 0x1F5) {
		this.writeInt8(0xFE);
		this.writeInt8(token - 0xF5);
	}

	return true;
};

Writer.prototype.writeJid = function(user, server) {
	this.writeInt8(0xFA);

	if(user.length) {
		this.writeString(user);
	} else {
		this.writeToken(0);
	}

	this.writeString(server);
};

Writer.prototype.writeBytes = function(bytes) {
	var len;
	
	if (typeof bytes == 'string')
		len = buffer.Buffer.byteLength(bytes,'utf8')
	else
		len = bytes.length;

	if(len >= 0x100) {
		this.writeInt8(0xFD);
		this.writeInt24(len);
	} else {
		this.writeInt8(0xFC);
		this.writeInt8(len);
	}

	if(bytes instanceof buffer.Buffer) {
		bytes.copy(this.output, this.offset);
	} else {
		this.output.write(bytes, this.offset);
	}


	this.offset += len;
};

Writer.prototype.writeInt8 = function(uint) {
	this.output.writeUInt8(uint, this.offset++);
};

Writer.prototype.writeInt16 = function(uint) {
	this.output.writeUInt16BE(uint, this.offset);
	this.offset += 2;
};

Writer.prototype.writeInt24 = function(uint) {
	this.output.writeUInt24BE(uint, this.offset);
	this.offset += 3;
};


Writer.prototype.getNodeBufferLength = function(node) {
	var size = 2;

	size += this.getStringBufferLength(node.tag());

	if(node.attributes() !== null) {
		size += this.getAttributesBufferLength(node.attributes());
	}

	if(node.data() !== '') {
		if (node.tag() =='body')
			size += this.getBodyRawBufferLength(node.data());
		else
			size += this.getRawBufferLength(node.data());
	}

	if(node.children().length) {
		size += 2;

		node.children().forEach(function(child) {
			size += this.getNodeBufferLength(child);
		}, this);
	}

	return size;
};

Writer.prototype.getStringBufferLength = function(string) {
	if(this.dictionary.hasOwnProperty(string)) {
		return this.getTokenBufferLength(this.dictionary[string]);
	}

	if(string.indexOf('@') != -1) {
		var parts   = string.split('@');
		var jidsize = 1;

		jidsize += parts[0].length
			? this.getStringBufferLength(parts[0])
			: this.getTokenBufferLength(0);

		jidsize += this.getStringBufferLength(parts[1]);

		return jidsize;
	}

	return this.getRawBufferLength(string);
};

Writer.prototype.getTokenBufferLength = function(token) {
	if(token < 0xF5) {
		return 1;
	}

	if(token < 0x1F5) {
		return 2;
	}

	return 0;
};

Writer.prototype.getAttributesBufferLength = function(attributes) {
	var size = 0;

	for(var key in attributes) {
		if(attributes.hasOwnProperty(key)) {
			size += this.getStringBufferLength(key) + this.getStringBufferLength(attributes[key]);
		}
	}

	return size;
};

Writer.prototype.getRawBufferLength = function(raw) {
	var size = raw.length + 2;

	return raw.length >= 0x100 ? size + 2 : size;
};

Writer.prototype.getBodyRawBufferLength = function(raw) {
	if (typeof raw == 'string')
	{
		var size = buffer.Buffer.byteLength(raw,'utf8') + 2;
	}
	else
	{
		var size = raw.length + 2;
	}
	return raw.length >= 0x100 ? size + 2 : size;
	};
exports.Buffer = Buffer;
exports.Node   = Node;
exports.Reader = Reader;
exports.Writer = Writer;
