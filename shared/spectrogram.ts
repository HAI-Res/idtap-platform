// Width in pixels of one spectrogram tile. The worker colorizes and ships the
// image in tiles of this width and SpectrogramLayer creates one <canvas> per
// tile, so both sides must agree.
export const SPECTROGRAM_TILE_WIDTH = 1000;
