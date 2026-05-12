/**
 * Volumetric |E|² field viewer — Phase C.8.
 *
 * Reads the ``EmFieldPayload`` from a completed em_fem run and feeds
 * it to vtk.js's volume renderer (volume ray casting on the GPU). The
 * mock palace solver in Phase C.5 produces a 16³ Gaussian blob so the
 * viewer exercises end-to-end without needing real palace output.
 *
 * When real palace runs (Phase C.4 over SSH), the payload changes to
 * ``available: false`` with a remote .pvtu path — the viewer will then
 * show a "field pull-down not yet implemented" placeholder. Phase C.8+
 * adds a backend streaming endpoint that swaps to a vtkXMLPolyDataReader.
 */
import "@kitware/vtk.js/Rendering/Profiles/Volume";

import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkFullScreenRenderWindow from "@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkPiecewiseFunction from "@kitware/vtk.js/Common/DataModel/PiecewiseFunction";
import vtkVolume from "@kitware/vtk.js/Rendering/Core/Volume";
import vtkVolumeMapper from "@kitware/vtk.js/Rendering/Core/VolumeMapper";
import { useEffect, useRef } from "react";

import type { EmFieldPayload } from "../../types/digitalTwin";

type Props = {
  field: EmFieldPayload;
};

export function FieldViewer({ field }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current || !field.available) return;
    const container = containerRef.current;

    // Clear any prior canvas left by a previous render (StrictMode
    // mount/unmount, hot reload).
    container.innerHTML = "";

    const fsrw = vtkFullScreenRenderWindow.newInstance({
      rootContainer: container,
      containerStyle: { width: "100%", height: "100%", position: "absolute" },
      background: [0.92, 0.92, 0.9],
    });
    const renderer = fsrw.getRenderer();
    const renderWindow = fsrw.getRenderWindow();

    const [nx, ny, nz] = field.dim;
    const flat = Float32Array.from(field.data);

    const imageData = vtkImageData.newInstance();
    imageData.setDimensions(nx, ny, nz);
    imageData.setSpacing(field.spacingMm[0], field.spacingMm[1], field.spacingMm[2]);
    imageData.setOrigin(field.originMm[0], field.originMm[1], field.originMm[2]);
    const scalars = vtkDataArray.newInstance({
      name: "scalars",
      values: flat,
      numberOfComponents: 1,
    });
    imageData.getPointData().setScalars(scalars);

    // Auto-range: use min/max of the data so the transfer functions cover it.
    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (let i = 0; i < flat.length; i++) {
      const v = flat[i];
      if (v < dataMin) dataMin = v;
      if (v > dataMax) dataMax = v;
    }
    if (!isFinite(dataMin)) {
      dataMin = 0;
      dataMax = 1;
    } else if (dataMin === dataMax) {
      dataMax = dataMin + 1e-6;
    }

    const ctf = vtkColorTransferFunction.newInstance();
    ctf.addRGBPoint(dataMin, 0.0, 0.0, 0.4); // dark blue
    ctf.addRGBPoint((dataMin + dataMax) * 0.5, 0.7, 0.2, 0.7); // magenta
    ctf.addRGBPoint(dataMax, 1.0, 0.9, 0.0); // yellow

    const ofun = vtkPiecewiseFunction.newInstance();
    ofun.addPoint(dataMin, 0.0);
    ofun.addPoint(dataMin + (dataMax - dataMin) * 0.2, 0.05);
    ofun.addPoint(dataMax, 0.4);

    const mapper = vtkVolumeMapper.newInstance();
    mapper.setInputData(imageData);
    mapper.setSampleDistance(0.7);

    const volume = vtkVolume.newInstance();
    volume.setMapper(mapper);
    volume.getProperty().setRGBTransferFunction(0, ctf);
    volume.getProperty().setScalarOpacity(0, ofun);
    volume.getProperty().setInterpolationTypeToLinear();
    volume.getProperty().setShade(true);
    volume.getProperty().setAmbient(0.2);
    volume.getProperty().setDiffuse(0.7);
    volume.getProperty().setSpecular(0.3);

    renderer.addVolume(volume);
    renderer.resetCamera();
    renderWindow.render();

    return () => {
      try {
        fsrw.delete();
      } catch {
        // ignore — vtk.js cleanup can throw if WebGL context is already gone.
      }
      container.innerHTML = "";
    };
  }, [field]);

  if (!field.available) {
    return (
      <div className="field-viewer-placeholder">
        <strong>Field pull-down not yet implemented</strong>
        <div className="field-viewer-placeholder-meta">
          format: <code>{field.format}</code>
          {field.remoteHost && (
            <>
              <br />host: <code>{field.remoteHost}</code>
            </>
          )}
          {field.remotePath && (
            <>
              <br />path: <code>{field.remotePath}</code>
            </>
          )}
          {field.note && (
            <>
              <br />
              <em>{field.note}</em>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="field-viewer-block">
      <div className="field-viewer-title">{field.label}</div>
      <div ref={containerRef} className="field-viewer-canvas" />
    </div>
  );
}
