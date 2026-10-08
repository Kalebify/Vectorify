from fastapi import Depends

from app.core.config import Settings, get_settings
from app.services.color_palette_service import ColorPaletteService
from app.services.component_analysis_service import ComponentAnalysisService
from app.services.geometry_service import GeometryService
from app.services.info_service import InfoService
from app.services.path_checker_service import PathCheckerService
from app.services.physical_union_service import PhysicalUnionService
from app.services.preprocessing_service import PreprocessingService
from app.services.simplification_service import SimplificationService
from app.services.threshold_service import ThresholdingService
from app.services.vectorization_service import VectorizationService


def get_info_service(settings: Settings = Depends(get_settings)) -> InfoService:
    return InfoService(settings)


def get_preprocessing_service(settings: Settings = Depends(get_settings)) -> PreprocessingService:
    return PreprocessingService(settings)


def get_threshold_service(settings: Settings = Depends(get_settings)) -> ThresholdingService:
    return ThresholdingService(settings)


def get_vectorization_service(settings: Settings = Depends(get_settings)) -> VectorizationService:
    return VectorizationService(settings)


def get_simplification_service(settings: Settings = Depends(get_settings)) -> SimplificationService:
    return SimplificationService(settings)


def get_path_checker_service(settings: Settings = Depends(get_settings)) -> PathCheckerService:
    return PathCheckerService(settings)


def get_color_palette_service(settings: Settings = Depends(get_settings)) -> ColorPaletteService:
    return ColorPaletteService(settings)


def get_component_analysis_service(settings: Settings = Depends(get_settings)) -> ComponentAnalysisService:
    return ComponentAnalysisService(settings)


def get_physical_union_service(settings: Settings = Depends(get_settings)) -> PhysicalUnionService:
    return PhysicalUnionService(settings)


def get_geometry_service(settings: Settings = Depends(get_settings)) -> GeometryService:
    return GeometryService(settings)
