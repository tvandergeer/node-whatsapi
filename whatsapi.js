var util        = require('util');
var events      = require('events');
var fs          = require('fs');
var crypto      = require('crypto');
var url         = require('url');
var tls         = require('tls');
var http        = require('http');
var https       = require('https');
var querystring = require('querystring');
var imagick     = require('imagemagick');
var mime        = require('mime');
var common      = require('./common');
var dictionary  = require('./dictionary_new');
var protocol    = require('./protocol');
var transports  = require('./transport');
var encryption  = require('./encryption');
var processors  = require('./processors');

var MediaType = {
	IMAGE : 'image',
	VIDEO : 'video',
	AUDIO : 'audio'
};

function WhatsApi(config, reader, writer, processor, transport) {
	this.config    = common.extend({}, this.defaultConfig, config);
	this.reader    = reader;
	this.writer    = writer;
	this.processor = processor;
	this.transport = transport;

	events.EventEmitter.call(this);

	this.init();
}

util.inherits(WhatsApi, events.EventEmitter);

WhatsApi.prototype.defaultConfig = {
	msisdn         : '',
	device_id      : '',
	username       : '',
	password       : '',
	ccode          : '',
	reconnect      : true,
	host           : 'c.whatsapp.net',
	server         : 's.whatsapp.net',
	gserver        : 'g.us',
	port           : 5222,
	device_type    : 'Android',
	app_version    : '2.11.339',
	ua             : 'WhatsApp/2.11.339 Android/4.0.4 Device/GalaxyS3',
	challenge_file : __dirname + '/challenge'
};

WhatsApi.prototype.mediaMimeTypes = {};

WhatsApi.prototype.mediaMimeTypes[MediaType.IMAGE] = {
	size : 5 * 1024 * 1024,
	mime : ['image/png', 'image/gif', 'image/jpeg']
};

WhatsApi.prototype.mediaMimeTypes[MediaType.VIDEO] = {
	size : 20 * 1024 * 1024,
	mime : ['video/mp4', 'video/quicktime', 'video/x-msvideo']
};

WhatsApi.prototype.mediaMimeTypes[MediaType.AUDIO] = {
	size : 10 * 1024 * 1024,
	mime : [
		'video/3gpp',
		'audio/x-caf',
		'audio/x-wav',
		'audio/mpeg',
		'audio/x-ms-wma',
		'video/ogg',
		'audio/x-aiff',
		'audio/x-aac'
	]
};

WhatsApi.prototype.init = function() {
	this.transport.onReceive(this.onTransportData, this);
	this.transport.onError(this.onTransportError, this);
	this.transport.onEnd(this.onTransportEnd, this);

	this.connected   = false;
	this.challenge   = null;
	this.messageId   = 0;
	this.queue       = [];
	this.loggedIn    = false;
	this.mediaQueue  = {};
	this.selfAddress = this.createJID(this.config.msisdn);

	this.processor.setAdapter(this);
};

WhatsApi.prototype.connect = function() {
	this.loggedIn = false;
	this.transport.connect(this.config.host, this.config.port, this.onTransportConnect, this);
};

WhatsApi.prototype.disconnect = function() {
	this.transport.disconnect();
};

WhatsApi.prototype.login = function() {
	this.reader.setKey(null);
	this.writer.setKey(null);

	var resource = [this.config.device_type, this.config.app_version, this.config.port].join('-');

	this.send(this.writer.stream(this.config.server, resource));
	this.sendNode(this.createFeaturesNode());
	this.sendNode(this.createAuthNode());
};

WhatsApi.prototype.sendIsOnline = function() {
	var attributes = {
		//type : 'available',
		name : this.config.username
	};

	this.sendNode(new protocol.Node('presence', attributes));
};

WhatsApi.prototype.sendIsOffline = function() {
	var attributes = {
		type : 'unavailable',
		name : this.config.username
	};

	this.sendNode(new protocol.Node('presence', attributes));
};

WhatsApi.prototype.sendMessageComposing = function(to) {

	var state = new protocol.Node('composing', {xmlns : 'http://jabber.org/protocol/chatstates'});

	var attributes = {
		to : this.createJID(to),
		type : 'text',
		t : common.tstamp().toString()
	};

    this.sendNode(new protocol.Node('message', attributes, [state]));
};

WhatsApi.prototype.sendMessagePaused = function(to) {
	var state = new protocol.Node('paused', {xmlns : 'http://jabber.org/protocol/chatstates'});

	var attributes = {
		to : this.createJID(to),
		type : 'text',
		t : common.tstamp().toString()
	};
	
    this.sendNode(new protocol.Node('message', attributes, [state]));
};

WhatsApi.prototype.sendMessage = function(to, message, msgid) {
	this.sendMessageNode(to, new protocol.Node('body', null, null, message), msgid);
};

WhatsApi.prototype.sendLocation = function(to, lat, lng, name, url, msgid) {
	var attributes = {
		xmlns     : 'urn:xmpp:whatsapp:mms',
		type      : 'location',
		latitude  : lat.toString(),
		longitude : lng.toString(),
		name      : name || '',
		url       : url || ''
	};

	this.sendMessageNode(to, new protocol.Node('media', attributes), msgid);
};

WhatsApi.prototype.sendImage = function(to, filepath, msgid) {
	this.sendMedia(to, filepath, MediaType.IMAGE, msgid);
};

WhatsApi.prototype.sendVideo = function(to, filepath, msgid) {
	this.sendMedia(to, filepath, MediaType.VIDEO, msgid);
};

WhatsApi.prototype.sendAudio = function(to, filepath, msgid) {
	this.sendMedia(to, filepath, MediaType.AUDIO, msgid);
};

WhatsApi.prototype.sendMedia = function(to, filepath, type, msgid) {
	this.getMediaFile(filepath, type, function(err, path) {
		if(err) {
			this.emit('media.error', err);
			return;
		}

		var stat = fs.statSync(path);
		var hash = crypto.createHash('sha256').update(fs.readFileSync(path)).digest('base64');

		this.sendNode(this.createRequestMediaUploadNode(hash, type, stat.size, path, to, msgid));
	}.bind(this));
};

WhatsApi.prototype.requestGroupList = function(type) {
	type = type || 'participating';

	var listNode = new protocol.Node('list', {xmlns : 'w:g', type : type});

	var attributes = {
		id   : this.nextMessageId('getgroups'),
		type : 'get',
		to   : this.config.gserver
	};

	this.sendNode(new protocol.Node('iq', attributes, [listNode]));
};

WhatsApi.prototype.requestGroupMembers = function(groupId) {
	var listNode = new protocol.Node('list', {xmlns : 'w:g'});

	var attributes = {
		id   : this.nextMessageId('groupmembers'),
		type : 'get',
		to   : this.createJID(groupId)
	};

	this.sendNode(new protocol.Node('iq', attributes, [listNode]));
};

WhatsApi.prototype.requestGroupsLeave = function(groupIds) {
	var groupNodes = [];

	for (var i = 0; i < groupIds.length; i++) {
		groupNodes.push(new protocol.Node('group', {id : this.createJID(groupIds[i])}));
	};

	var leaveNode = new protocol.Node('leave', {xmlns : 'w:g', action : 'delete'}, groupNodes);

	var attributes = {
		id   : this.nextMessageId('leavegroups'),
		to   : this.config.gserver,
		type : 'set'
	};

	this.sendNode(new protocol.Node('iq', attributes, [leaveNode]));
};

WhatsApi.prototype.requestGroupInfo = function(groupId) {
	var queryNode = new protocol.Node('query', {xmlns : 'w:g'});

	var attributes = {
		id   : this.nextMessageId('groupinfo'),
		type : 'get',
		to   : this.createJID(groupId)
	};

	this.sendNode(new protocol.Node('iq', attributes, [queryNode]));
};

WhatsApi.prototype.createGroup = function(subject) {
	var groupNode = new protocol.Node('group', {xmlns: 'w:g', action : 'create', subject: subject});

	var attributes = {
		id   : this.nextMessageId('creategroup'),
		type : 'set',
		//xmlns: 'w:g',
		to   : this.config.gserver
	};

	this.sendNode(new protocol.Node('iq', attributes, [groupNode]));
};

WhatsApi.prototype.requestLastSeen = function(who) {
	var queryNode = new protocol.Node('query', {xmlns : 'jabber:iq:last'});

	var attributes = {
		to   : this.createJID(who),
		type : 'get',
		id   : this.nextMessageId('lastseen'),
		from : this.createJID(this.config.msisdn)
	};

	this.sendNode(new protocol.Node('iq', attributes, [queryNode]));
};

WhatsApi.prototype.sendPresenceSubscription = function(who) {
	var attributes = {
		type : 'subscribe',
		to : this.createJID(who)
	};
	var node = new protocol.Node('presence', attributes);
	
	this.sendNode(node);
};

WhatsApi.prototype.sendPresenceUnsubscription = function(who) {
	var attributes = {
		type : 'unsubscribe',
		to : this.createJID(who)
	};
	var node = new protocol.Node('presence', attributes);
	
	this.sendNode(node);
};

WhatsApi.prototype.setProfilePicture = function(filepath) {
//See this discussion when moving to WAUTH-2: https://github.com/tgalal/yowsup/issues/296
//The xmlns needs to be moved to the parent node and the order of thumb and fullsize picture is reversed
	var pictureNode, thumbNode;
	var attributes = {
		id: this.nextMessageId('setphoto'),
		to: this.createJID(this.config.msisdn),
		type: 'set'
	};

	var onThumbReady = function(err, data) {
		//data is returned as a base64 string
		if(err) {
			this.emit('media.error', err);
			return;
		}
		thumbNode = new protocol.Node('picture', {type:'preview', xmlns:'w:profile:picture'}, null, new Buffer(data, 'base64'));
		this.sendNode(new protocol.Node('iq', attributes, [thumbNode, pictureNode]));
	}.bind(this);

	this.getMediaFile(filepath, MediaType.IMAGE, function(err, path) {
		if(err) {
			this.emit('media.error', err);
			return;
		}
		
		fs.readFile(path, function(err, data) {
				if(err) {
					this.emit('media.error', err);
					return;
				}
				pictureNode = new protocol.Node('picture', null, null, data); 
				this.createImageThumbnail(path, onThumbReady);
		}.bind(this));
		
	}.bind(this));
};

WhatsApi.prototype.requestProfilePicture = function(target, small) {
	var picAttributes = {
		xmlns : 'w:profile:picture',
		type  : 'image'
	};

	if(small) {
		picAttributes['type'] = 'preview';
	}

	var pictureNode = new protocol.Node('picture', picAttributes);

	var attributes = {
		id   : this.nextMessageId('profilepicture'),
		type : 'get',
		to   : this.createJID(target)
	};

	this.sendNode(new protocol.Node('iq', attributes, [pictureNode]));
};

//Ported from WhatsAPI-PHP. This functionality works but am unable to get the result[failed and sync numbers]
WhatsApi.prototype.requestSync = function(msisdnList) {

	var contacts = [];
	for (var number in msisdnList){
		var contact = new protocol.Node('user', null, null, ('+' + msisdnList[number]));
		contacts.push(contact);
	}
	
	var attributes = {
		to    : this.selfAddress,
		type  : 'get',
		id    : this.nextMessageId('sendsync_'),
		xmlns : 'urn:xmpp:whatsapp:sync'
	};

	var attr = {
	mode    : 'full',
        context : 'interactive',
        sid     : ''+((common.tstamp().toString() + 11644477200) * 10000000),
        index   : ''+0,
        last    : 'true'
	};

	var syncnode = new protocol.Node('sync', attr, contacts);

	var messageNode = new protocol.Node('iq', attributes, [syncnode]);
	
	this.sendNode(messageNode);
};

WhatsApi.prototype.sendMessageNode = function(to, node, msgid) {
	if(!this.loggedIn) {
		this.queue.push({to : to, node : node});
		return;
	}

	var serverNode  = new protocol.Node('server');
	var xNode       = new protocol.Node('x', {xmlns : 'jabber:x:event'}, [serverNode]);
	var notyAttrs   = {xmlns : 'urn:xmpp:whatsapp', name : this.config.username};
	var notifyNode  = new protocol.Node('notify', notyAttrs);
	var requestNode = new protocol.Node('request', {xmlns : 'urn:xmpp:receipts'});

	var attributes = {
		to   : this.createJID(to),
		type : 'text',
		id   : msgid || this.nextMessageId('message'),
		t    : common.tstamp().toString()
	};

	var messageNode = new protocol.Node('message', attributes, [xNode, notifyNode, requestNode, node]);

	this.sendNode(messageNode);
};

WhatsApi.prototype.flushQueue = function() {
	var queue  = this.queue;
	this.queue = [];

	queue.forEach(function(elem) {
		this.sendMessageNode(elem.to, elem.node);
	}, this);
};

WhatsApi.prototype.sendNode = function(node) {
	node && this.send(this.writer.node(node));
};

WhatsApi.prototype.send = function(buffer) {
	this.transport.send(buffer);
};

WhatsApi.prototype.processNode = function(node) {	
	if(node.shouldBeReplied() && node.attribute('from') !== this.selfAddress) {
		this.sendNode(this.createReceivedNode(node));
	}

	if(node.isChallenge()) {
		this.sendNode(this.createAuthResposeNode(node.data()));
		this.reader.setKey(this.readerKey);
		this.writer.setKey(this.writerKey);
		return;
	}

	if(node.isSuccess()) {
		fs.writeFile(this.config.challenge_file, node.data());
		
		//this.initKeys(node.data());
		//this.reader.setKey(this.readerKey);
		this.writer.setKey(this.writerKey);
		
		this.loggedIn = true;
		this.flushQueue();
		this.emit('login');
		return;
	}

	if(node.isAvailable() && node.attribute('from') !== this.selfAddress) {
		this.emit('presence.available', node.attribute('from'), node.attribute('type'));
	}

	if(node.isDirtyPresence()) {
		this.sendNode(this.createClearDirtyNode(node));
		return;
	}

	if(node.isPing()) {
		this.sendNode(this.createPongNode(node.attribute('id')));
		return;
	}

	if(node.isMediaReady()) {
		this.createMediaUploadNode(node, function(err, to, node) {
			if(err) {
				this.emit('media.error', err);
				return;
			}

			this.sendMessageNode(to, node);
		}.bind(this));
		return;
	}

	if(node.isGroupList()) {
		var groupList = node.children().map(function(child) {
			return {
				groupId : child.attribute('id'),
				topic   : child.attribute('subject')
			};
		});

		this.emit('group.list', groupList);
		return;
	}

	if(node.isGroupAdd()) {
		this.emit('group.new', node.attribute('from'), node.child('body').data().toString('utf8'));
		return;
	}

	if(node.isGroupTopic()) {
		this.emit('group.topic', node.attribute('from'), node.child('body').data().toString('utf8'));
		return;
	}

	if(node.isGroupMembers()) {
		var members = node.children().map(function(child) {
			return child.attribute('jid');
		});

		this.emit('group.members', node.attribute('from'), members);
		return;
	}

	if(node.isGroupNewcomer() && node.attribute('add') !== this.selfAddress) {
		this.emit('group.newcomer', node.attribute('from'), node.attribute('add'));
		return;
	}

	if(node.isGroupOutcomer()) {
		if(node.attribute('remove') === this.selfAddress) {
			this.emit('group.excommunicate', node.attribute('from'));
		} else {
			this.emit('group.outcomer',
				node.attribute('from'), node.attribute('remove'), node.attribute('author'));
		}
	}
	
	if(node.isGroupCreated()) {
		var group ={
			id: node.attribute('id'), //id of the message that created the group
			groupId: node.child('group').attribute('id')
		};
		this.emit('group.created', group);
	}
	
	if(node.isSync()) {
		this.emit('sync', node.attribute('index'), node.attribute('sync'), node.child('in'), node.child('out'));
	}
	
	if(node.isLastSeen()) {
		var tstamp = Date.now() - (+node.child('query').attribute('seconds')) * 1000;
		this.emit('lastseen.found', node.attribute('from'), new Date(tstamp));
		return;
	}

	if(node.isNotFound()) {
		this.emit('lastseen.notfound', node.attribute('from'));
		return;
	}

	if(node.isFailure()) {
		this.emit('error', node.toXml());
		return;
	}

	if(node.isReceived()) {
		this.emit('message.delivered', node.attribute('from'), node.attribute('id'), node.attribute('t'));
		return;
	}

	if(node.isProfilePicture()) {
		var preview = node.child('picture').attribute('type') === 'preview';
		this.emit('profile.picture', node.attribute('from'), preview, node.child('picture').data());
		return;
	}

	if(node.isMessage()) {
		this.processor.process(node);
	}
	
	if(node.isTyping()) {
		this.emit('typing', node.attribute('from'), node.contents.children[0].contents.tag);
	}
};

WhatsApi.prototype.createFeaturesNode = function() {
	var features = [
		// //new protocol.Node('receipt_acks'),
		// //new protocol.Node('status')
		// new protocol.Node('readreceipts'),
		// new protocol.Node('groups_v2'),
		// new protocol.Node('privacy'),
		// new protocol.Node('presence')
	];

	return new protocol.Node('stream:features', null, features);
};

WhatsApi.prototype.createAuthNode = function() {
	var attributes = {
		//xmlns     : 'urn:ietf:params:xml:ns:xmpp-sasl',
		mechanism : 'WAUTH-2',
		user      : this.config.msisdn
	};

return new protocol.Node('auth', attributes, null, this.createAuthData());
};

WhatsApi.prototype.createAuthData = function() {
	var challenge = fs.readFileSync(this.config.challenge_file);

	if(!challenge.length) {
		return '';
	}

	//this.initKeys(challenge);
	var key = encryption.pbkdf2(new Buffer(this.config.password, 'base64'), challenge, 16, 20);
	this.readerKey = new encryption.KeyStream(new Buffer([key[2]]), new Buffer([key[3]]));
	this.writerKey = new encryption.KeyStream(new Buffer([key[0]]), new Buffer([key[1]]));


	this.reader.setKey(this.readerKey);

	var arr = Buffer.concat([
		new Buffer([0,0,0,0]),
		new Buffer(this.config.msisdn),
		challenge,
		new Buffer(common.tstamp().toString()),
		new Buffer(this.config.ua),
		new Buffer(' MccMnc/' + this.config.ccode + '001')
	]);
	return this.writerKey.encodeMessage(arr, 0, arr.length, 0);
};

WhatsApi.prototype.createAuthResposeNode = function(challenge) {
  //console.log(challenge.toString('hex'));
	this.initKeys(challenge);

	var arr = Buffer.concat([
		new Buffer([0,0,0,0]),
		new Buffer(this.config.msisdn),
		challenge
	]);
	//console.log(arr.toString('hex'));
	var data = this.writerKey.encodeMessage(arr, 0,4,arr.length -4);
  //console.log(data.toString('hex'));
	return new protocol.Node('response', {xmlns : 'urn:ietf:params:xml:ns:xmpp-sasl'}, null, data);
};

WhatsApi.prototype.generateKeys = function(password, nonce) {
	var keys = [];
	for(var j=1;j<5;j++){
		var currNonce = Buffer.concat( [nonce, new Buffer([j])] );
		keys.push( encryption.pbkdf2(new Buffer(password, 'base64'), currNonce, 2, 20) );		
	}
	return keys;
};

WhatsApi.prototype.initKeys = function(nonce) {
	var keys = this.generateKeys(this.config.password, nonce);

	this.readerKey = new encryption.KeyStream(keys[2], keys[3]);
	this.writerKey = new encryption.KeyStream(keys[0], keys[1]);
};

WhatsApi.prototype.createClearDirtyNode = function(node) {
	var categories = [];

	var children = node.children();
	if(children.length) {
		for (var i = 0; i < children.length; i++) {
			var child = node.child(i);
			if(child.tag() === 'category') {
				categories.push(new protocol.Node('category', {name : child.attribute('name')}));
			}
		};
	}

	var cleanNode = new protocol.Node('clean', {xmlns : 'urn:xmpp:whatsapp:dirty'}, categories);

	var attributes = {
		id   : this.nextMessageId('cleardirty'),
		type : 'set',
		to   : this.config.server
	};

	return new protocol.Node('iq', attributes, [cleanNode]);
};

WhatsApi.prototype.createPongNode = function(messageId) {
	var attributes = {
		to   : this.config.server,
		id   : messageId,
		type : 'result'
	};

	return new protocol.Node('iq', attributes);
};

WhatsApi.prototype.createReceivedNode = function(node) {
	var request  = node.child('request');
	var received = node.child('received');

	if(!request && !received) {
		return false;
	}

	var receivedNode = new protocol.Node(received ? 'ack' : 'received', {xmlns : 'urn:xmpp:receipts'});

	var attributes = {
		to   : node.attribute('from'),
		type : 'text',
		id   : node.attribute('id'),
		t    : common.tstamp().toString()
	};

	return new protocol.Node('message', attributes, [receivedNode]);
};

WhatsApi.prototype.createRequestMediaUploadNode = function(filehash, filetype, filesize, filepath, to, msgid) {
	var attributes = {
		xmlns : 'w:m',
		hash  : filehash,
		type  : filetype,
		size  : filesize.toString()
	};

	var mediaNode = new protocol.Node('media', attributes);

	var iqAttributes = {
		id   : msgid || this.nextMessageId('upload'),
		to   : this.config.server,
		type : 'set'
	};

	this.mediaQueue[iqAttributes.id] = {
		filepath : filepath,
		filesize : filesize,
		to       : to,
		from     : this.config.msisdn
	};

	return new protocol.Node('iq', iqAttributes, [mediaNode]);
};

WhatsApi.prototype.createMediaUploadNode = function(node, callback) {
	var id = node.attribute('id');

	if(!this.mediaQueue.hasOwnProperty(id)) {
		return;
	}

	var queued = this.mediaQueue[id];
	delete this.mediaQueue[id];

	var attributes = {
		xmlns : 'urn:xmpp:whatsapp:mms'
	};

	var onAttributesReady = function(url, type, size, file) {
		attributes.url  = url;
		attributes.type = type;
		attributes.size = size;
		attributes.file = file;

		var onThumbReady = function(err, data) {
			if(err) {
				callback(err);
				return;
			}

			callback(false, queued.to, new protocol.Node('media', attributes, null, data));
		};

		if(type === MediaType.IMAGE) {
			this.createImageThumbnail(queued.filepath, onThumbReady);
			return;
		}

		if(type === MediaType.VIDEO) {
			this.createVideoThumbnail(queued.filepath, onThumbReady);
			return;
		}

		onThumbReady(false, '');
	}.bind(this);

	var duplicate = node.child('duplicate');

	if(duplicate) {
		onAttributesReady(
			duplicate.attribute('url'),
			duplicate.attribute('type'),
			duplicate.attribute('size'),
			duplicate.attribute('url').replace(/(?:.*\/|^)([^\/]+)$/, '$1')
		);
	} else {
		this.uploadMediaFile(queued, node.child('media').attribute('url'), function(err, response) {
			if(err) {
				callback(err);
				return;
			}

			onAttributesReady(response.url, response.type, response.size, response.name);
		});
	}
};

WhatsApi.prototype.getMediaFile = function(filepath, filetype, callback) {
	if(!this.mediaMimeTypes.hasOwnProperty(filetype)) {
		callback('Invalid file type: ' + filetype);
		return;
	}

	var onFileReady = function(path) {
		var mimeType = mime.lookup(path);

		if(this.mediaMimeTypes[filetype].mime.indexOf(mimeType) === -1) {
			callback('Invalid file mime type: ' + mimeType);
			return;
		}

		var fileSize = fs.statSync(path).size;
		var maxSize  = this.mediaMimeTypes[filetype].size;

		if(maxSize < fileSize) {
			callback('Media file too big (max size is ' + maxSize + ' file size is ' + fileSize + ')');
			return;
		}

		callback(false, path);
	}.bind(this);

	fs.exists(filepath, function(result) {
		if(result) {
			onFileReady(filepath);
			return;
		}

		var parsed = url.parse(filepath);

		if(!parsed.host) {
			callback('Filepath is nor url neither path to existing file');
			return;
		}

		this.downloadMediaFile(filepath, function(err, path) {
			if(err) {
				callback(err);
			} else {
				onFileReady(path);
			}
		});
	}.bind(this));
};

WhatsApi.prototype.downloadMediaFile = function(destUrl, callback) {
	var match = destUrl.match(/\.[^\/.]+$/);

	var ext = match ? match[0] : '';

	var schema = url.parse(destUrl).protocol;

	var reqObj = schema === 'https:' ? https : http;

	reqObj.get(destUrl, function(res) {
		var buffers = [];

		res.on('data', function(data) {
			buffers.push(data);
		});

		res.on('end', function() {
			var path = __dirname + '/media/media-' + crypto.randomBytes(4).readUInt32LE(0) + ext;

			fs.writeFile(path, Buffer.concat(buffers), function(err) {
				if(err) {
					callback('Error saving downloaded file: ' + err);
				} else {
					callback(false, path);
				}
			});
		});
	}).on('error', function(e) {
		callback('HTTP error: ' + e.message);
	});
};

WhatsApi.prototype.uploadMediaFile = function(queue, destUrl, callback) {
	var type       = mime.lookup(queue.filepath);
	var ext        = mime.extension(type);
	var boundary   = 'zzXXzzYYzzXXzzQQ';
	var filename   = crypto.createHash('md5').update(queue.filepath).digest('hex') + '.' + ext;
	var host       = url.parse(destUrl).hostname;
	var contentLen = 0;

	var post = [
		'--' + boundary,
		'Content-Disposition: form-data; name="to"\r\n',
		this.createJID(queue.to),
		'--' + boundary,
		'Content-Disposition: form-data; name="from"\r\n',
		queue.from,
		'--' + boundary,
		'Content-Disposition: form-data; name="file"; filename="' + filename + '"',
		'Content-Type: ' + type + '\r\n'
	];

	var end = '\r\n--' + boundary + '--\r\n';

	post.forEach(function(str) {
		contentLen += str.length + 2;
	});

	contentLen += queue.filesize + end.length;

	var headers = [
		'POST ' + destUrl,
		'Content-Type: multipart/form-data; boundary=' + boundary,
		'Host: ' + host,
		'User-Agent: ' + this.config.ua,
		'Content-Length: ' + contentLen + '\r\n'
	];

	var options = {
		port : 443,
		host : host,
		rejectUnauthorized : false
	};

	var tlsStream = tls.connect(options, function() {
		headers.forEach(function(str) {
			tlsStream.write(str + '\r\n');
		});

		post.forEach(function(str) {
			tlsStream.write(str + '\r\n');
		});

		var filestream = fs.createReadStream(queue.filepath);

		filestream.pipe(tlsStream, {end : false});

		filestream.on('end', function() {
			tlsStream.write(end);
		});
	});

	tlsStream.on('error', function(err) {
		this.emit('media.error', 'SSL/TLS error: ' + err);
	}.bind(this));

	var buffers = [];

	tlsStream.on('data', function(data) {
		buffers.push(data);
	});

	tlsStream.on('end', function() {
		var result = Buffer.concat(buffers).toString();

		try {
			callback(false, JSON.parse(result.split('\r\n\r\n').pop()));
		} catch(e) {
			callback('Unexpected upload response: ' + result);
		}
	});
};

WhatsApi.prototype.createImageThumbnail = function(srcPath, callback) {
	var dstPath = srcPath.replace(/^(.*?)(\.[^.]+$|$)/, '$1-thumb$2');

	var opts = {
		srcPath : srcPath,
		dstPath : dstPath,
		quality : 0.5,
		width   : 100,
		height  : 100
	};

	try {
		imagick.resize(opts, function(err) {
			if(err) {
				callback(err);
				return;
			}

			fs.readFile(dstPath, function(err, data) {
				if(err) {
					callback(err);
					return;
				}

				callback(false, data.toString('base64'));
			});
		});
	} catch(e) {
		callback(false, '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');
	}
};

WhatsApi.prototype.createVideoThumbnail = function(srcPath, callback) {
	callback(false, '/9j/4QAYRXhpZgAASUkqAAgAAAAAAAAAAAAAAP/sABFEdWNreQABAAQAAABQAAD/4QMpaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLwA8P3hwYWNrZXQgYmVnaW49Iu+7vyIgaWQ9Ilc1TTBNcENlaGlIenJlU3pOVGN6a2M5ZCI/PiA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJBZG9iZSBYTVAgQ29yZSA1LjAtYzA2MCA2MS4xMzQ3NzcsIDIwMTAvMDIvMTItMTc6MzI6MDAgICAgICAgICI+IDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+IDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIgeG1sbnM6eG1wTU09Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8iIHhtbG5zOnN0UmVmPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VSZWYjIiB4bXA6Q3JlYXRvclRvb2w9IkFkb2JlIFBob3Rvc2hvcCBDUzUgV2luZG93cyIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo2MTQyRUVCOEI3MDgxMUUyQjNGQkY1OEU5M0U2MDE1MyIgeG1wTU06RG9jdW1lbnRJRD0ieG1wLmRpZDo2MTQyRUVCOUI3MDgxMUUyQjNGQkY1OEU5M0U2MDE1MyI+IDx4bXBNTTpEZXJpdmVkRnJvbSBzdFJlZjppbnN0YW5jZUlEPSJ4bXAuaWlkOjYxNDJFRUI2QjcwODExRTJCM0ZCRjU4RTkzRTYwMTUzIiBzdFJlZjpkb2N1bWVudElEPSJ4bXAuZGlkOjYxNDJFRUI3QjcwODExRTJCM0ZCRjU4RTkzRTYwMTUzIi8+IDwvcmRmOkRlc2NyaXB0aW9uPiA8L3JkZjpSREY+IDwveDp4bXBtZXRhPiA8P3hwYWNrZXQgZW5kPSJyIj8+/+4ADkFkb2JlAGTAAAAAAf/bAIQAAgICAgICAgICAgMCAgIDBAMCAgME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');
};

WhatsApi.prototype.nextMessageId = function(prefix) {
	return [prefix, common.tstamp(), ++this.messageId].join('-');
};

WhatsApi.prototype.createJID = function(msisdn) {
	msisdn = msisdn.toString();
	if(msisdn.indexOf('@') !== -1) {
		return msisdn;
	}

	var affix = msisdn.indexOf('-') === -1 ? this.config.server : this.config.gserver;

	return msisdn + '@' + affix;
};

WhatsApi.prototype.onTransportConnect = function() {
	this.emit('connect');
};

WhatsApi.prototype.onTransportError = function(e) {
	this.emit(this.connected ? 'error' : 'connectError', e);
};

WhatsApi.prototype.onTransportEnd = function() {
	if(this.config.reconnect) {
		this.emit('reconnect');
		this.connect();
	} else {
		this.emit('end');
	}
};

WhatsApi.prototype.onTransportData = function(data) {
	//console.log("incoming data: "+ data.toString('hex'));
	this.reader.appendInput(data);

	while(true) {
		var node = this.reader.nextNode();

		if(node === false) {
			break;
		}

		if(node) {
			this.processNode(node);
		}
	}
};

function WhatsApiDebug() {
	WhatsApiDebug.super_.apply(this, arguments);
}

util.inherits(WhatsApiDebug, WhatsApi);

WhatsApiDebug.prototype.processNode = function(node) {
	node && console.log(node.toXml('rx '));
	return WhatsApiDebug.super_.prototype.processNode.apply(this, arguments);
};

WhatsApiDebug.prototype.sendNode = function(node) {
	node && console.log(node.toXml('tx '));
	return WhatsApiDebug.super_.prototype.sendNode.apply(this, arguments);
};

function WhatsApiRegistration(config) {
	this.config = common.extend({}, this.defaultConfig, config);

	events.EventEmitter.call(this);
}

util.inherits(WhatsApiRegistration, events.EventEmitter);

WhatsApiRegistration.prototype.defaultConfig = {
	msisdn     : '',
	device_id  : '',
	ccode      : '',
	ua         : 'WhatsApp/2.11.69 Android/4.3 Device/GalaxyS3',
	language   : 'uz',
	country    : 'UZ',
	magic_file : __dirname + '/magic'
};

WhatsApiRegistration.prototype.checkCredentials = function() {
	this.request('exist', {c : 'cookie'}, function(response, source) {
		if(response.status !== 'fail') {
			this.emit('error', 'Invalid response status: ' + source);
			return;
		}

		switch(response.reason) {
			case 'blocked':
				this.emit('credentials.blocked', this.config.msisdn);
				break;
			case 'incorrect':
				this.emit('credentials.notfound', this.config.msisdn);
				break;
			case 'bad_param':
				this.emit('error', 'bad params: ' + source);
				break;
			case 'format_wrong':
				this.emit('error', 'msisdn cannot be used');
				break;
			case 'missing_param':
				this.emit('error', 'missing param: ' + source);
				break;
			default:
				this.emit('error', 'Credentials check fail with unexpected reason: ' + source);
		}
	}.bind(this));
};

WhatsApiRegistration.prototype.requestCode = function() {
	var match = this.config.msisdn.match(/^998(\d+)$/);

	if(!match) {
		this.emit('error', 'Invalid msisdn provided');
	}

	var token = this.generateToken('Uzbekistan', match[1]);

	var params = {
		to     : this.config.msisdn,
		lg     : this.config.language,
		lc     : this.config.country,
		method : 'sms',
		mcc    : this.config.ccode,
		mnc    : '001',
		token  : token
	};

	this.request('code', params, function(response, source) {
		if(response.status === 'sent') {
			this.emit('code.sent', this.config.msisdn);
			return;
		}

		if(response.reason === 'too_recent') {
			this.emit('code.wait', this.config.msisdn, response.retry_after);
			return;
		}

		this.emit('error', 'Code request error: ' + source);
	}.bind(this));
};

WhatsApiRegistration.prototype.registerCode = function(code) {
	var params = {
		c    : 'cookie',
		code : code
	};

	this.request('register', params, function(response, source) {
		this.emit('error', 'Code registration failed: ' + source);
	});
};

WhatsApiRegistration.prototype.request = function(method, queryParams, callback) {
	var match = this.config.msisdn.match(/^998(\d+)$/);

	if(!match) {
		this.emit('error', 'Invalid msisdn provided');
	}

	var query = {
		cc : '998',
		in : match[1],
		id : querystring.unescape(this.config.device_id)
	};

	if(queryParams instanceof Function) {
		callback = queryParams;
	} else {
		common.extend(query, queryParams);
	}

	var url = {
		hostname : 'v.whatsapp.net',
		path     : '/v2/' + method + '?' + querystring.stringify(query),
		headers  : {
			'User-Agent' : this.config.ua,
			'Accept'     : 'text/json'
		}
	};

	var req = https.get(url, function(res) {
		var buffers = [];

		res.on('data', function(buf) {
			buffers.push(buf);
		});

		res.on('end', function() {
			var jsonbody = Buffer.concat(buffers).toString();

			try {
				var response = JSON.parse(jsonbody);
			} catch(e) {
				this.emit('error', 'Non-json response: ' + response);
				return;
			}

			if(response.status !== 'ok') {
				callback(response, jsonbody);
				return;
			}

			this.emit('success',
				this.config.msisdn,
				response.login,
				response.pw,
				response.type,
				response.expiration,
				response.kind,
				response.price,
				response.cost,
				response.currency,
				response.price_expiration
			);
		}.bind(this));
	}.bind(this));

	req.on('error', function(e) {
		this.emit('error', e);
	}.bind(this));
};

WhatsApiRegistration.prototype.generateToken = function(country, msisdn) {
	var magicxor  = new Buffer('The piano has been drinkin', 'utf8');
	var magicfile = fs.readFileSync(this.config.magic_file);

	for(var i = 0, idx = 0; i < magicfile.length; i++, idx++) {
		if(idx === magicxor.length) {
			idx = 0;
		}

		magicfile[i] = magicfile[i] ^ magicxor[idx];
	}

	var password = Buffer.concat([
		new Buffer('Y29tLndoYXRzYXBw', 'base64'),
		magicfile
	]);

	var salt = new Buffer('PkTwKSZqUfAUyR0rPQ8hYJ0wNsQQ3dW1+3SCnyTXIfEAxxS75FwkDf47wNv/c8pP3p0GXKR6OOQmhyERwx74fw1RYSU10I4r1gyBVDbRJ40pidjM41G1I1oN', 'base64');

	var key = encryption.pbkdf2(password, salt, 128, 80);

	var padlen = 64;

	var opad = new Buffer(padlen);
	var ipad = new Buffer(padlen);

	for(var i = 0; i < padlen; i++) {
		opad[i] = 0x5C ^ key[i];
		ipad[i] = 0x36 ^ key[i];
	}

	var ipadHash = crypto.createHash('sha1');

	var data = Buffer.concat([
		new Buffer('MIIDMjCCAvCgAwIBAgIETCU2pDALBgcqhkjOOAQDBQAwfDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCkNhbGlmb3JuaWExFDASBgNVBAcTC1NhbnRhIENsYXJhMRYwFAYDVQQKEw1XaGF0c0FwcCBJbmMuMRQwEgYDVQQLEwtFbmdpbmVlcmluZzEUMBIGA1UEAxMLQnJpYW4gQWN0b24wHhcNMTAwNjI1MjMwNzE2WhcNNDQwMjE1MjMwNzE2WjB8MQswCQYDVQQGEwJVUzETMBEGA1UECBMKQ2FsaWZvcm5pYTEUMBIGA1UEBxMLU2FudGEgQ2xhcmExFjAUBgNVBAoTDVdoYXRzQXBwIEluYy4xFDASBgNVBAsTC0VuZ2luZWVyaW5nMRQwEgYDVQQDEwtCcmlhbiBBY3RvbjCCAbgwggEsBgcqhkjOOAQBMIIBHwKBgQD9f1OBHXUSKVLfSpwu7OTn9hG3UjzvRADDHj+AtlEmaUVdQCJR+1k9jVj6v8X1ujD2y5tVbNeBO4AdNG/yZmC3a5lQpaSfn+gEexAiwk+7qdf+t8Yb+DtX58aophUPBPuD9tPFHsMCNVQTWhaRMvZ1864rYdcq7/IiAxmd0UgBxwIVAJdgUI8VIwvMspK5gqLrhAvwWBz1AoGBAPfhoIXWmz3ey7yrXDa4V7l5lK+7+jrqgvlXTAs9B4JnUVlXjrrUWU/mcQcQgYC0SRZxI+hMKBYTt88JMozIpuE8FnqLVHyNKOCjrh4rs6Z1kW6jfwv6ITVi8ftiegEkO8yk8b6oUZCJqIPf4VrlnwaSi2ZegHtVJWQBTDv+z0kqA4GFAAKBgQDRGYtLgWh7zyRtQainJfCpiaUbzjJuhMgo4fVWZIvXHaSHBU1t5w//S0lDK2hiqkj8KpMWGywVov9eZxZy37V26dEqr/c2m5qZ0E+ynSu7sqUD7kGx/zeIcGT0H+KAVgkGNQCo5Uc0koLRWYHNtYoIvt5R3X6YZylbPftF/8ayWTALBgcqhkjOOAQDBQADLwAwLAIUAKYCp0d6z4QQdyN74JDfQ2WCyi8CFDUM4CaNB+ceVXdKtOrNTQcc0e+t', 'base64'),
		new Buffer('30CnAF22oY+2PUD5pcJGqw==', 'base64'),
		new Buffer(msisdn)
	]);

	ipadHash.update(ipad);
	ipadHash.update(data);

	var output = crypto.createHash('sha1');

	output.update(opad);
	output.update(ipadHash.digest());

	return output.digest('base64');
};


function createAdapter(config, debug, reader, writer, processor, transport) {
	reader    = reader    || new protocol.Reader(dictionary);
	writer    = writer    || new protocol.Writer(dictionary);
	processor = processor || processors.createProcessor();
	transport = transport || new transports.Socket;

	var WhatsApp = debug ? WhatsApiDebug : WhatsApi;

	return new WhatsApp(config, reader, writer, processor, transport);
}

function createContactsSync(config) {
	return new WhatsApiContactsSync(config);
}

function createRegistration(config) {
	return new WhatsApiRegistration(config);
}

exports.createAdapter      = createAdapter;
exports.createContactsSync = createContactsSync;
exports.createRegistration = createRegistration;
