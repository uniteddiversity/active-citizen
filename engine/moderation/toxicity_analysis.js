const models = require("../../../models");
const async = require('async');
const moment = require('moment');
const log = require('../../utils/logger');
const _ = require('lodash');

const TOXICITY_THRESHOLD = 0.50;
const TOXICITY_EMAIL_THRESHOLD = 0.75;

const Perspective = require('perspective-api-client');
let perspectiveApi;
if (process.env.GOOGLE_PERSPECTIVE_API_KEY) {
  perspectiveApi = new Perspective({apiKey: process.env.GOOGLE_PERSPECTIVE_API_KEY});
}

const getToxicityScoreForText = (text, doNotStore, callback) => {
  log.info("getToxicityScoreForText starting", { text, doNotStore });
  if (text && text!=="") {
    perspectiveApi.analyze(text, { doNotStore, attributes: [
        'TOXICITY', 'SEVERE_TOXICITY','IDENTITY_ATTACK',
        'THREAT','INSULT','PROFANITY','SEXUALLY_EXPLICIT',
        'FLIRTATION'] }).then( result => {
      log.info("getToxicityScoreForText results", { result });
      callback(null, result);
    }).catch( error => {
      log.error("getToxicityScoreForText error", { error });
      callback(error);
    });
  } else {
    callback("No text for toxicity score");
  }
};

const setupModelPublicDataScore = (model, text, results) => {
  if (!model.data)
    model.set('data', {});
  if (!model.data.moderation)
    model.set('data.moderation', {});
  model.set('data.moderation.rawToxicityResults', results);

  let toxicityScore, severeToxicityScore, identityAttackScore, threatScore, insultScore,
    profanityScore, sexuallyExplicitScore, flirtationScore;

  try {
    toxicityScore = results.attributeScores["TOXICITY"].summaryScore.value;
    severeToxicityScore = results.attributeScores["SEVERE_TOXICITY"].summaryScore.value;
    identityAttackScore = results.attributeScores["IDENTITY_ATTACK"].summaryScore.value;
    threatScore = results.attributeScores["THREAT"].summaryScore.value;
    insultScore = results.attributeScores["INSULT"].summaryScore.value;
    profanityScore = results.attributeScores["PROFANITY"].summaryScore.value;
    sexuallyExplicitScore = results.attributeScores["SEXUALLY_EXPLICIT"].summaryScore.value;
    flirtationScore = results.attributeScores["FLIRTATION"].summaryScore.value;
  } catch (error) {
    log.error(error);
  }

  model.set('data.moderation.toxicityScore', toxicityScore);
  model.set('data.moderation.severeToxicityScore', severeToxicityScore);
  model.set('data.moderation.identityAttackScore', identityAttackScore);
  model.set('data.moderation.threatScore', threatScore);
  model.set('data.moderation.insultScore', insultScore);
  model.set('data.moderation.profanityScore', profanityScore);
  model.set('data.moderation.sexuallyExplicitScore', sexuallyExplicitScore);
  model.set('data.moderation.flirtationScore', flirtationScore);
  model.set('data.moderation.textUsedForScore', text);
};

const hasModelBreachedToxicityThreshold = model => {
  if (model.data && model.data.moderation && (model.data.moderation.toxicityScore || model.data.moderation.severeToxicityScore)) {
    if (model.data.moderation.toxicityScore>TOXICITY_THRESHOLD) {
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
};

const hasModelBreachedToxicityEmailThreshold = model => {
  if (model.data && model.data.moderation && (model.data.moderation.toxicityScore || model.data.moderation.severeToxicityScore)) {
    if (model.data.moderation.toxicityScore>TOXICITY_EMAIL_THRESHOLD) {
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
};

const getTranslatedTextForPost = (post, callback) => {
  let postName, postDescription, postTranscript;
  async.parallel([
    (parallelCallback) => {
      const req = { query: {
        textType: 'postName',
        targetLanguage: 'en'
      }};
      models.AcTranslationCache.getTranslation(req, post, (error, translation) => {
        if (error) {
          parallelCallback(error);
        } else {
          postName = translation;
          parallelCallback();
        }
      });
    },
    (parallelCallback) => {
      const req = { query: {
        textType: 'postContent',
        targetLanguage: 'en'
      }};
      models.AcTranslationCache.getTranslation(req, post, (error, translation) => {
        if (error) {
          parallelCallback(error);
        } else {
          postDescription = translation;
          parallelCallback();
        }
      });
    },
    (parallelCallback) => {
      const req = { query: {
          textType: 'postTranscriptContent',
          targetLanguage: 'en'
        }};
      models.AcTranslationCache.getTranslation(req, post, (error, translation) => {
        if (error) {
          log.warn("No text from translate", { error });
          parallelCallback();
        } else {
          postTranscript = translation;
          parallelCallback();
        }
      });
    }
  ], error => {
    if (postName && postDescription) {
      callback(error, `${postName.content} ${postDescription.content} ${postTranscript? postTranscript.content : ''}`);
    } else {
      log.error("No postname for toxicity!", { error });
      callback(error);
    }
  });
};

const getTranslatedTextForPoint = (point, callback) => {
  const req = {
    query: {
      textType: 'pointContent',
      targetLanguage: 'en'
    }
  };
  models.AcTranslationCache.getTranslation(req, point, (error, translation) => {
    if (error) {
      callback(error);
    } else {
      callback(null, translation);
    }
  });
};

const estimateToxicityScoreForPost = (options, callback) => {
  if (process.env.GOOGLE_PERSPECTIVE_API_KEY) {
    log.info("getToxicityScoreForText post preparing");
    models.Post.find({
      where: {
        id: options.postId
      },
      include: [
        {
          model: models.Audio,
          as: 'PostAudios',
          required: false
        },
        {
          model: models.Video,
          as: 'PostVideos',
          required: false
        },
        {
          model: models.Group,
          attributes: ['id', 'access'],
          include: [
            {
              model: models.Community,
              required: true,
              attributes: ['id', 'access'],
              include: [
                {
                  model: models.Domain,
                  required: true,
                  attributes: ['id']
                }
              ]
            }
          ]
        },
        {
          model: models.User,
          attribues: ['id','age_group']
        }
      ],
      attributes: ['id','name','description','language','data','group_id','public_data']
    }).then( post => {
      if (post) {
        let doNotStoreValue = post.Group.access===0 && post.Group.Community.access === 0;
        if (post.User.age_group && (post.User.age_group==="0-12" || post.User.age_group==="0"))
          doNotStoreValue = true;

        let textContent, textUsed, transcriptText;

        if (post.public_data &&
            post.public_data.transcript &&
            post.public_data.transcript.text) {
          transcriptText = post.public_data.transcript.text;
        }

        textContent = `${post.name} ${post.description} ${transcriptText? transcriptText : ''}`;

        if (post.language && post.language.substring(0,2)==="en") {
          textUsed = textContent;
          log.info("getToxicityScoreForText post getting english text");
          getToxicityScoreForText(textUsed, doNotStoreValue, callback);
        } else if (textContent && textContent!=='') {
          log.info("getToxicityScoreForText post getting translated text");
          getTranslatedTextForPost(post, (error, translatedText) => {
            log.info("getToxicityScoreForText post got translated text", { translatedText, error });
            if (error)
              callback(error);
            else
              textUsed = translatedText;
              getToxicityScoreForText(textUsed, doNotStoreValue, (error, results) => {
                if (error) {
                  callback(error);
                } else {
                  setupModelPublicDataScore(post, textUsed, results);
                  post.save().then(() => {
                    if (hasModelBreachedToxicityThreshold(post)) {
                      post.report({ disableNotification: !hasModelBreachedToxicityEmailThreshold(post) },
                                  "perspectiveAPI",
                                  callback);
                    } else {
                      callback();
                    }
                  }).catch( error => {
                    callback(error);
                  })
                }
              });
          });
        } else {
          log.warn("getToxicityScoreForText post No text for toxicity");
          callback();
        }
      } else {
        log.error("getToxicityScoreForText post could not find post");
        callback("Could not find post");
      }
    }).catch( error => {
      log.error("getToxicityScoreForText post error", { error });
      callback(error);
    })
  } else {
    callback("No API key");
  }
};

const estimateToxicityScoreForPoint = (options, callback) => {
  if (process.env.GOOGLE_PERSPECTIVE_API_KEY) {
    log.info("getToxicityScoreForText preparing");
    models.Point.find({
      attributes: ['id','language','data','post_id','group_id'],
      where: {
        id: options.pointId
      },
      include: [
        {
          model: models.Audio,
          as: 'PointAudios',
          required: false
        },
        {
          model: models.Video,
          as: 'PointVideos',
          required: false
        },
        {
          model: models.Group,
          attributes: ['id', 'access'],
          required: false,
          include: [
            {
              model: models.Community,
              required: false,
              attributes: ['id', 'access']
            }
          ]
        },
        {
          model: models.PointRevision,
          attribues: ['id','content']
        },
        {
          model: models.User,
          attribues: ['id','age_group']
        }
      ]
    }).then( point => {
      if (point) {
        let doNotStoreValue = true;
        if (point.Group && point.Group.access===0 && (!point.Group.Community || point.Group.Community.access === 0))
          doNotStoreValue = false;

        if (point.User && point.User.age_group && (point.User.age_group==="0-12" || point.User.age_group==="0"))
          doNotStoreValue = true;

        let textContent, textUsed;

        textContent = point.PointRevisions[point.PointRevisions.length-1].content;

        if (point.language && point.language.substring(0,2)==="en") {
          textUsed = textContent;
          log.info("getToxicityScoreForText getting english text");
          getToxicityScoreForText(textContent, doNotStoreValue, callback);
        } else if (textContent && textContent!=='') {
          log.info("getToxicityScoreForText getting translated text");
          getTranslatedTextForPoint(point, (error, translatedText) => {
            log.info("getToxicityScoreForText got translated text", { translatedText, error });
            if (error)
              callback(error);
            else
              textUsed = translatedText.content;
              getToxicityScoreForText(textUsed, doNotStoreValue, (error, results) => {
                if (error) {
                  callback(error);
                } else {
                  setupModelPublicDataScore(point, textUsed, results);
                  point.save().then(() => {
                    if (hasModelBreachedToxicityThreshold(point)) {
                      if (point.post_id) {
                        models.Post.find({
                          where: {
                            id: point.post_id
                          },
                          attributes: ["id",'data'],
                          include: [
                            {
                              model: models.Group,
                              attributes: ['id'],
                              include: [
                                {
                                  model: models.Community,
                                  attributes: ['id'],
                                  include: [
                                    {
                                      model: models.Domain,
                                      attributes: ['id']
                                    }
                                  ]
                                }
                              ]
                            }
                          ]
                        }).then(post => {
                          point.report({ disableNotification: !hasModelBreachedToxicityEmailThreshold(point) },
                                       'perspectiveAPI',
                                        post, callback);
                        }).catch( error => {
                          callback(error);
                        });
                      } else {
                        point.report({ disableNotification: !hasModelBreachedToxicityEmailThreshold(point) },
                                    'perspectiveAPI', null, callback);
                      }
                    } else {
                      callback();
                    }
                  }).catch( error => {
                    callback(error);
                  })
                }
              });
          });
        } else {
          log.warn("getToxicityScoreForText No text for toxicity");
          callback();
        }
      } else {
        log.error("getToxicityScoreForText could not find point");
        callback("Could not find point");
      }
    }).catch( error => {
      log.error("getToxicityScoreForText error", { error });
      callback(error);
    })
  } else {
    callback("No Google API key");
  }
};

module.exports = {
  estimateToxicityScoreForPoint,
  estimateToxicityScoreForPost
};