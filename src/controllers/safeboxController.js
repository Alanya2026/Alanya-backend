/**
 * Coffre-fort — traduction HTTP du service (`src/services/safebox/service.js`).
 *
 * Aucune règle ici : le service décide, lève des `SafeboxError` à code stable
 * (docs/error-codes.md), et ce contrôleur les rend par `fail()`.
 */

const { fail, failInternal } = require('../utils/apiError');
const { SafeboxError } = require('../services/safebox/errors');
const { SafeboxKeyUnavailable } = require('../services/safebox/keys');
const { safeboxService } = require('../services/safebox/service');

function sendError(res, err, tag) {
  if (err instanceof SafeboxError) return fail(res, err.status, err.code, err.message, err.extra);
  if (err instanceof SafeboxKeyUnavailable) {
    console.error(`[safebox] ${tag} : clé maîtresse indisponible —`, err.message);
    return fail(res, 503, 'SAFEBOX_UNAVAILABLE', 'Coffre-fort indisponible');
  }
  console.error(`[safebox] ${tag} :`, err);
  return failInternal(res);
}

/** Enveloppe un appel de service : `fn(service, req)` rend le corps de la réponse. */
const route = (tag, fn, statut = 200) => async (req, res) => {
  try {
    const corps = await fn(safeboxService(), req);
    return res.status(statut).json(corps);
  } catch (err) {
    return sendError(res, err, tag);
  }
};

const moi = (req) => req.user.alanyaID;

exports.overview = route('overview', (s, req) => s.overview(moi(req)));
exports.listFolder = route('listFolder', (s, req) => s.listFolder(moi(req), req.params.id, { cursor: req.query.cursor }));
exports.createFolder = route('createFolder', (s, req) => s.createFolder(moi(req), req.body), 201);
exports.updateFolder = route('updateFolder', (s, req) => s.updateFolder(moi(req), req.params.id, req.body));
exports.trashFolder = route('trashFolder', (s, req) => s.trashFolder(moi(req), req.params.id));
exports.restoreFolder = route('restoreFolder', (s, req) => s.restoreFolder(moi(req), req.params.id));

exports.updateFile = route('updateFile', (s, req) => s.updateFile(moi(req), req.params.id, req.body));
exports.setNoteText = route('setNoteText', (s, req) => s.setNoteText(moi(req), req.params.id, req.body));
exports.reserveNoteAudio = route('reserveNoteAudio', (s, req) => s.reserveNoteAudio(moi(req), req.params.id, req.body));
exports.completeNoteAudio = route('completeNoteAudio', (s, req) => s.completeNoteAudio(moi(req), req.params.id, req.body));
exports.deleteNoteAudio = route('deleteNoteAudio', (s, req) => s.deleteNoteAudio(moi(req), req.params.id));
exports.trashFile = route('trashFile', (s, req) => s.trashFile(moi(req), req.params.id, {
  everywhere: ['1', 'true'].includes(String(req.query.everywhere)),
}));
exports.addToFolder = route('addToFolder', (s, req) => s.addToFolder(moi(req), req.params.id, req.body));
exports.restoreFile = route('restoreFile', (s, req) => s.restoreFile(moi(req), req.params.id));
exports.downloadFile = route('downloadFile', (s, req) => s.downloadFile(moi(req), req.params.id));
exports.createShare = route('createShare', (s, req) => s.createShare(moi(req), req.body), 201);
exports.shareInfo = route('shareInfo', (s, req) => s.shareInfo(moi(req), req.params.id));
exports.shareItems = route('shareItems', (s, req) => s.shareItems(moi(req), req.params.id, { cursor: req.query.cursor }));
exports.shareDownload = route('shareDownload', (s, req) => s.shareDownload(moi(req), req.params.id, { item: req.query.item }));
exports.saveShare = route('saveShare', (s, req) => s.saveShare(moi(req), req.params.id, req.body), 201);
exports.receivedShares = route('receivedShares', (s, req) => s.receivedShares(moi(req), { cursor: req.query.cursor }));
exports.shareRecipients = route('shareRecipients', (s, req) => s.shareRecipients(moi(req), req.params.id));
exports.revokeShare = route('revokeShare', (s, req) => s.revokeShare(moi(req), req.params.id));
exports.largestFiles = route('largestFiles', (s, req) => s.largestFiles(moi(req), { limit: req.query.limit }));

exports.reserveUpload = route('reserveUpload', (s, req) => s.reserveUpload(moi(req), req.body), 201);
exports.uploadStatus = route('uploadStatus', (s, req) => s.uploadStatus(moi(req), req.params.id));
exports.uploadUrls = route('uploadUrls', (s, req) => s.uploadUrls(moi(req), req.params.id, req.body));
exports.completeUpload = route('completeUpload', (s, req) => s.completeUpload(moi(req), req.params.id, req.body));
exports.cancelUpload = route('cancelUpload', (s, req) => s.cancelUpload(moi(req), req.params.id));

exports.listTrash = route('listTrash', (s, req) => s.listTrash(moi(req)));
exports.emptyTrash = route('emptyTrash', (s, req) => s.emptyTrash(moi(req)));
exports.deleteTrashedFile = route('deleteTrashedFile', (s, req) => s.deleteTrashedFile(moi(req), req.params.id));
exports.deleteTrashedFolder = route('deleteTrashedFolder', (s, req) => s.deleteTrashedFolder(moi(req), req.params.id));

// Pour `safeboxController.test.js`.
exports._sendError = sendError;
